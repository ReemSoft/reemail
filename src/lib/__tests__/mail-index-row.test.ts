import { describe, expect, it } from "vitest";
import {
  decodeIndexCursor,
  encodeIndexCursor,
  indexRowToMailMessage,
  type IndexRow,
} from "@/lib/mail-index-row";

const baseRow: IndexRow = {
  uid: 42,
  subject: "Hello",
  from_addr: { name: "Ada", email: "ada@example.com" },
  to_addrs: [{ name: "", email: "you@example.com" }],
  cc_addrs: null,
  internal_date: "2026-01-15T12:34:56.000Z",
  seen: false,
  flagged: true,
  has_attachments: false,
  message_id: "<abc@example.com>",
};

describe("indexRowToMailMessage", () => {
  it("builds a stable id from folder + uid", () => {
    const m = indexRowToMailMessage("inbox", baseRow);
    expect(m.id).toBe("inbox:42");
    expect(m.folder).toBe("inbox");
  });

  it("uses message_id as threadId when present", () => {
    const m = indexRowToMailMessage("inbox", baseRow);
    expect(m.threadId).toBe("<abc@example.com>");
  });

  it("falls back to folder:uid for threadId when message_id is null", () => {
    const m = indexRowToMailMessage("inbox", { ...baseRow, message_id: null });
    expect(m.threadId).toBe("inbox:42");
  });

  it("maps flags to boolean read/starred", () => {
    const m = indexRowToMailMessage("inbox", baseRow);
    expect(m.read).toBe(false);
    expect(m.starred).toBe(true);
  });

  it("coerces from_addr with missing name to use email as name", () => {
    const m = indexRowToMailMessage("inbox", {
      ...baseRow,
      from_addr: { email: "x@y.z" },
    });
    expect(m.from).toEqual({ name: "x@y.z", email: "x@y.z" });
  });

  it("returns empty from when from_addr is null", () => {
    const m = indexRowToMailMessage("inbox", { ...baseRow, from_addr: null });
    expect(m.from).toEqual({ name: "", email: "" });
  });

  it("filters out empty entries from to/cc arrays", () => {
    const m = indexRowToMailMessage("inbox", {
      ...baseRow,
      to_addrs: [{ name: "", email: "" }, { name: "K", email: "k@x" }],
      cc_addrs: [{ name: "", email: "cc@x" }],
    });
    expect(m.to).toEqual([{ name: "K", email: "k@x" }]);
    expect(m.cc).toEqual([{ name: "cc@x", email: "cc@x" }]);
  });

  it("omits cc when there are no valid entries", () => {
    const m = indexRowToMailMessage("inbox", { ...baseRow, cc_addrs: [] });
    expect(m.cc).toBeUndefined();
  });

  it("leaves preview and body empty (fetched on open)", () => {
    const m = indexRowToMailMessage("inbox", baseRow);
    expect(m.preview).toBe("");
    expect(m.body).toBe("");
  });

  it("uses epoch when internal_date is null", () => {
    const m = indexRowToMailMessage("inbox", { ...baseRow, internal_date: null });
    expect(m.date).toBe(new Date(0).toISOString());
  });
});

describe("index cursor codec", () => {
  it("round-trips date + id", () => {
    const c = { date: "2026-01-15T12:34:56.000Z", id: "abc-123" };
    expect(decodeIndexCursor(encodeIndexCursor(c))).toEqual(c);
  });

  it("returns null for malformed input", () => {
    expect(decodeIndexCursor("!!not-base64!!")).toBeNull();
    expect(decodeIndexCursor(Buffer.from("not json").toString("base64url"))).toBeNull();
    expect(
      decodeIndexCursor(Buffer.from(JSON.stringify({ date: 1 })).toString("base64url")),
    ).toBeNull();
  });
});
