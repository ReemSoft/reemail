import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseInlinePartRequest } from "../../routes/api/mail-inline-part";

const VALID = {
  mailSessionToken: "token",
  password: "secret",
  folder: "inbox",
  uid: 42,
  uidValidity: "77",
  part: "2.1",
};

describe("dedicated large inline CID route", () => {
  it("accepts only the protected physical-message payload", () => {
    expect(parseInlinePartRequest(VALID)).toEqual(VALID);
    expect(parseInlinePartRequest({ ...VALID, account: { imap_host: "attacker" } })).toBeNull();
  });

  it("enforces folder, positive UID, and strict IMAP part syntax", () => {
    expect(parseInlinePartRequest({ ...VALID, folder: "evil" })).toBeNull();
    expect(parseInlinePartRequest({ ...VALID, uid: 0 })).toBeNull();
    expect(parseInlinePartRequest({ ...VALID, uid: 1.5 })).toBeNull();
    expect(parseInlinePartRequest({ ...VALID, uidValidity: "0" })).toBeNull();
    expect(parseInlinePartRequest({ ...VALID, uidValidity: "stale" })).toBeNull();
    expect(parseInlinePartRequest({ ...VALID, part: "2.x" })).toBeNull();
    expect(parseInlinePartRequest({ ...VALID, part: "2 BODY.PEEK[]" })).toBeNull();
  });

  it("accepts one bounded multi-part request and rejects mixed/surplus payloads", () => {
    const physical = {
      mailSessionToken: VALID.mailSessionToken,
      password: VALID.password,
      folder: VALID.folder,
      uid: VALID.uid,
      uidValidity: VALID.uidValidity,
    };
    const parts = Array.from({ length: 5 }, (_, index) => ({
      cid: `cid-${index}`,
      part: `2.${index + 1}`,
      mimeType: "image/png",
      size: 300 * 1024,
    }));
    expect(parseInlinePartRequest({ ...physical, parts })).toEqual({ ...physical, parts });
    expect(parseInlinePartRequest({ ...VALID, parts })).toBeNull();
    expect(parseInlinePartRequest({ ...physical, parts: Array(21).fill(parts[0]) })).toBeNull();
  });

  it("resolves authenticated Bridge account data and streams no Base64", () => {
    const source = readFileSync("src/routes/api/mail-inline-part.ts", "utf8");
    expect(source).toContain("resolveBridgeAuth(payload.mailSessionToken)");
    expect(source).toContain("account: auth.bridgeAccount");
    expect(source).toContain("expectedUidValidity: payload.uidValidity");
    expect(source).toContain("/api/message-inline-part");
    expect(source).toContain("new Response(upstream.body");
    expect(source).toContain('upstream.headers.get("Retry-After")');
    expect(source).toContain('{ "Retry-After": retryAfter }');
    expect(source).not.toContain("base64");
  });
});
