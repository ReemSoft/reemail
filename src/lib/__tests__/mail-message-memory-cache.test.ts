import { describe, expect, it } from "vitest";
import type { MailMessage } from "../mail-types";
import {
  MessageMemoryCache,
  messageMemoryCacheKey,
  validUidValidity,
} from "../mail-message-memory-cache";

const scope = { companyId: "company-1", accountId: "account-1" };

function message(uid: number, body = "body", uidValidity = "7"): MailMessage {
  return {
    id: `inbox:${uid}`,
    threadId: `thread-${uid}`,
    folder: "inbox",
    from: { name: "Sender", email: "sender@example.test" },
    to: [{ name: "Recipient", email: "recipient@example.test" }],
    subject: `subject-${uid}`,
    preview: "preview",
    body,
    date: "2026-01-01T00:00:00.000Z",
    read: false,
    starred: false,
    hasAttachments: false,
    uidValidity,
  };
}

describe("MAILMAESTRO_INSTANT_NAVIGATION_R1 memory cache", () => {
  it("serves a memory hit without invoking a loader", async () => {
    const cache = new MessageMemoryCache();
    const load = async () => message(1);
    cache.set(scope, await load());
    let serverFunctions = 0;
    const opened = cache.get(scope, message(1)) ?? (serverFunctions++, await load());
    expect(opened?.body).toBe("body");
    expect(serverFunctions).toBe(0);
  });

  it("evicts least-recently-used rows at the 25-row cap", () => {
    const cache = new MessageMemoryCache({ maxRows: 25 });
    for (let uid = 1; uid <= 25; uid++) cache.set(scope, message(uid));
    cache.get(scope, message(1));
    cache.set(scope, message(26));
    expect(cache.get(scope, message(1))).not.toBeNull();
    expect(cache.get(scope, message(2))).toBeNull();
    expect(cache.stats().rows).toBe(25);
  });

  it("enforces byte and TTL limits", () => {
    let now = 0;
    const cache = new MessageMemoryCache({ maxBytes: 2_000, ttlMs: 100, now: () => now });
    cache.set(scope, message(1, "x".repeat(2_000)));
    expect(cache.stats().rows).toBe(0);
    cache.set(scope, message(2));
    now = 101;
    expect(cache.get(scope, message(2))).toBeNull();
  });

  it("invalidates an old UIDVALIDITY identity and clears account data", () => {
    const cache = new MessageMemoryCache();
    cache.set(scope, message(1, "old", "7"));
    cache.set(scope, message(1, "new", "8"));
    expect(cache.get(scope, message(1, "", "7"))).toBeNull();
    expect(cache.get(scope, message(1, "", "8"))?.body).toBe("new");
    cache.clear();
    expect(cache.stats().rows).toBe(0);
  });

  it("never creates or reads a cache key without a positive UIDVALIDITY", () => {
    expect(validUidValidity(undefined)).toBeNull();
    expect(validUidValidity("unknown")).toBeNull();
    expect(validUidValidity("0")).toBeNull();
    expect(messageMemoryCacheKey(scope, message(1, "body", ""))).toBeNull();
    const cache = new MessageMemoryCache();
    expect(cache.set(scope, message(1, "body", "unknown"))).toBe(false);
    expect(cache.stats().rows).toBe(0);
  });

  it("keeps completed folders warm and rejects a reused UID after UIDVALIDITY changes", () => {
    const cache = new MessageMemoryCache();
    const inbox = message(1, "inbox-body", "7");
    const sent = { ...message(1, "sent-body", "9"), id: "sent:1", folder: "sent" as const };
    cache.set(scope, inbox);
    cache.set(scope, sent);
    expect(cache.get(scope, inbox)?.body).toBe("inbox-body");
    expect(cache.get(scope, sent)?.body).toBe("sent-body");
    cache.retainUidValidity(scope, "inbox", "8");
    expect(cache.get(scope, inbox)).toBeNull();
    expect(cache.get(scope, message(1, "", "8"))).toBeNull();
    expect(cache.get(scope, sent)?.body).toBe("sent-body");
  });

  it("isolates companies/accounts and supports mutation invalidation/write-through", () => {
    const cache = new MessageMemoryCache();
    cache.set(scope, message(1));
    expect(cache.get({ ...scope, accountId: "account-2" }, message(1))).toBeNull();
    cache.patch(scope, "inbox:1", { read: true, starred: true });
    expect(cache.get(scope, message(1))).toMatchObject({ read: true, starred: true });
    cache.delete(scope, "inbox:1");
    expect(cache.get(scope, message(1))).toBeNull();
  });
});
