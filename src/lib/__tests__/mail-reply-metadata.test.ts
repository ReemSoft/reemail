import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { MailMessage } from "../mail-types";
import {
  MAX_THREAD_REFERENCES,
  buildReplyRecipients,
  buildThreadingHeaders,
  forwardSubject,
  formatComposeAddress,
  normalizeRfcMessageId,
  replySubject,
} from "../mail-reply-metadata";
import { readDraftDoc, writeDraftDoc, type DraftStorageLike } from "../mail-draft-lifecycle";

describe("compose subject prefixes", () => {
  it("does not accumulate case-insensitive reply or forward prefixes", () => {
    expect(replySubject("Topic موضوع")).toBe("Re: Topic موضوع");
    expect(replySubject("RE: Topic موضوع")).toBe("RE: Topic موضوع");
    expect(replySubject("Re : Topic")).toBe("Re : Topic");
    expect(forwardSubject("Topic موضوع")).toBe("Fwd: Topic موضوع");
    expect(forwardSubject("FW: Topic موضوع")).toBe("FW: Topic موضوع");
    expect(forwardSubject("FWD : Topic")).toBe("FWD : Topic");
  });
});

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: "inbox:3",
    threadId: "<m3@example.com>",
    folder: "inbox",
    from: { name: "Alice", email: "alice@example.com" },
    to: [{ name: "Me", email: "me@example.com" }],
    subject: "Subject",
    body: "",
    preview: "Preview",
    date: "2026-08-12T00:00:00.000Z",
    read: true,
    starred: false,
    hasAttachments: false,
    ...overrides,
  };
}

function storage(): DraftStorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe("reply recipient semantics", () => {
  it("uses From only when Reply-To is absent or unusable", () => {
    expect(buildReplyRecipients(message(), "me@example.com", false).to).toEqual([
      { name: "Alice", email: "alice@example.com" },
    ]);
    expect(
      buildReplyRecipients(
        message({ replyTo: [{ name: "", email: " \r\n" }] }),
        "me@example.com",
        false,
      ).to,
    ).toEqual([{ name: "Alice", email: "alice@example.com" }]);
  });

  it("honors one or multiple Reply-To addresses and preserves safe Unicode names", () => {
    const result = buildReplyRecipients(
      message({
        replyTo: [
          { name: "الدعم", email: "support+ar@example.com" },
          { name: "Team", email: "team@example.com" },
        ],
      }),
      "me@example.com",
      false,
    );
    expect(result.to).toEqual([
      { name: "الدعم", email: "support+ar@example.com" },
      { name: "Team", email: "team@example.com" },
    ]);
    expect(result.to.map(formatComposeAddress).join(", ")).toBe(
      "الدعم <support+ar@example.com>, Team <team@example.com>",
    );
  });

  it("builds Reply All To/Cc with case-insensitive self and global deduplication", () => {
    const result = buildReplyRecipients(
      message({
        replyTo: [{ name: "Support", email: "support@example.com" }],
        to: [
          { name: "Me", email: "ME@example.com" },
          { name: "Bob", email: "bob@example.com" },
        ],
        cc: [
          { name: "Carol", email: "carol@example.com" },
          { name: "Duplicate", email: "SUPPORT@example.com" },
          { name: "Bob duplicate", email: "BOB@example.com" },
        ],
      }),
      "me@example.com",
      true,
    );
    expect(result.to.map((item) => item.email)).toEqual(["support@example.com", "bob@example.com"]);
    expect(result.cc.map((item) => item.email)).toEqual(["carol@example.com"]);
  });

  it("keeps Reply distinct from Reply All", () => {
    const input = message({
      replyTo: [{ name: "Support", email: "support@example.com" }],
      to: [{ name: "Bob", email: "bob@example.com" }],
      cc: [{ name: "Carol", email: "carol@example.com" }],
    });
    expect(buildReplyRecipients(input, "me@example.com", false).cc).toEqual([]);
    expect(buildReplyRecipients(input, "me@example.com", false).to).toHaveLength(1);
  });

  it("does not retain recipient state between sequential composers", () => {
    const first = buildReplyRecipients(
      message({ replyTo: [{ name: "A", email: "a@example.com" }] }),
      "me@example.com",
      false,
    );
    const second = buildReplyRecipients(
      message({ replyTo: [{ name: "B", email: "b@example.com" }] }),
      "me@example.com",
      false,
    );
    expect(first.to[0]?.email).toBe("a@example.com");
    expect(second.to[0]?.email).toBe("b@example.com");
  });
});

describe("RFC threading metadata", () => {
  it.each([
    ["<m1@example.com>", "<m1@example.com>"],
    ["abc.123@example.com", "<abc.123@example.com>"],
    ["<odd+tag/[x]@mail.example>", "<odd+tag/[x]@mail.example>"],
  ])("normalizes a usable Message-ID %s", (input, expected) => {
    expect(normalizeRfcMessageId(input)).toBe(expected);
  });

  it.each([
    "folder:123",
    "inbox:55",
    "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "",
    " ",
    "<x@y>\r\nBcc: bad@example.com",
  ])("rejects a local, malformed, or injectable parent identity %s", (input) =>
    expect(normalizeRfcMessageId(input)).toBeNull(),
  );

  it("preserves order, normalizes brackets, removes duplicates, and appends the parent", () => {
    expect(
      buildThreadingHeaders(
        ["<a@example.com>", " b@example.com ", "<a@example.com>", "folder:4"],
        "<c@example.com>",
      ),
    ).toEqual({
      inReplyTo: "<c@example.com>",
      references: ["<a@example.com>", "<b@example.com>", "<c@example.com>"],
    });
    expect(buildThreadingHeaders(["<a@example.com>", "<c@example.com>"], "c@example.com")).toEqual({
      inReplyTo: "<c@example.com>",
      references: ["<a@example.com>", "<c@example.com>"],
    });
  });

  it("omits both headers when the parent Message-ID is unavailable", () => {
    expect(buildThreadingHeaders(["<a@example.com>"], "inbox:55")).toEqual({});
  });

  it("bounds pathological chains while retaining the root and newest ancestry", () => {
    const references = Array.from({ length: 140 }, (_, index) => `<m${index}@example.com>`);
    references.splice(2, 0, "<parent@example.com>");
    const result = buildThreadingHeaders(references, "<parent@example.com>");
    expect(result.references).toHaveLength(MAX_THREAD_REFERENCES);
    expect(result.references?.[0]).toBe("<m0@example.com>");
    expect(result.references?.at(-1)).toBe("<parent@example.com>");
  });

  it("round-trips reply metadata in a local draft without original-message lookup", () => {
    const local = storage();
    expect(
      writeDraftDoc(local, "me@example.com", {
        version: 3,
        draftId: "draft-1",
        snapshot: {
          to: [],
          cc: [],
          bcc: [],
          subject: "Reply",
          html: "<p>Body</p>",
          showCc: false,
          showBcc: false,
          inReplyTo: "<m3@example.com>",
          references: ["<m1@example.com>", "<m2@example.com>", "<m3@example.com>"],
        },
        serverRef: null,
        updatedAt: 1,
      }),
    ).toBe(true);
    expect(readDraftDoc(local, "me@example.com")?.snapshot).toMatchObject({
      inReplyTo: "<m3@example.com>",
      references: ["<m1@example.com>", "<m2@example.com>", "<m3@example.com>"],
    });
  });

  it("keeps Forward free of threading derivation in the production entrypoint", () => {
    const source = readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");
    const forward = source.slice(
      source.indexOf("function buildForward("),
      source.indexOf("const UUID_RE"),
    );
    expect(forward).not.toContain("buildThreadingHeaders");
  });
});
