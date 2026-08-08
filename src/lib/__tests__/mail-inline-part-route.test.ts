import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseInlinePartRequest } from "../../routes/api/mail-inline-part";

const VALID = {
  mailSessionToken: "token",
  password: "secret",
  folder: "inbox",
  uid: 42,
  part: "2.1",
};

describe("dedicated large inline CID route", () => {
  it("accepts only the protected five-field payload", () => {
    expect(parseInlinePartRequest(VALID)).toEqual(VALID);
    expect(parseInlinePartRequest({ ...VALID, account: { imap_host: "attacker" } })).toBeNull();
  });

  it("enforces folder, positive UID, and strict IMAP part syntax", () => {
    expect(parseInlinePartRequest({ ...VALID, folder: "evil" })).toBeNull();
    expect(parseInlinePartRequest({ ...VALID, uid: 0 })).toBeNull();
    expect(parseInlinePartRequest({ ...VALID, uid: 1.5 })).toBeNull();
    expect(parseInlinePartRequest({ ...VALID, part: "2.x" })).toBeNull();
    expect(parseInlinePartRequest({ ...VALID, part: "2 BODY.PEEK[]" })).toBeNull();
  });

  it("resolves authenticated Bridge account data and streams no Base64", () => {
    const source = readFileSync("src/routes/api/mail-inline-part.ts", "utf8");
    expect(source).toContain("resolveBridgeAuth(payload.mailSessionToken)");
    expect(source).toContain("account: auth.bridgeAccount");
    expect(source).toContain("/api/message-inline-part");
    expect(source).toContain("new Response(upstream.body");
    expect(source).not.toContain("base64");
  });
});
