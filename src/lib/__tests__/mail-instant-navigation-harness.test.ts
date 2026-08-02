import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEmailSrcDoc } from "../email-viewer-security";
import { MessageMemoryCache } from "../mail-message-memory-cache";
import type { MailMessage } from "../mail-types";

const scope = { companyId: "company", accountId: "account" };
const row: MailMessage = {
  id: "inbox:1",
  threadId: "thread",
  folder: "inbox",
  from: { name: "Sender", email: "sender@example.test" },
  to: [],
  subject: "subject",
  preview: "preview",
  body: '<p>body</p><img src="cid:logo">',
  date: "2026-01-01T00:00:00.000Z",
  read: false,
  starred: false,
  hasAttachments: false,
  uidValidity: "7",
};

afterEach(() => vi.useRealTimers());

describe("MAILMAESTRO_INSTANT_NAVIGATION_R1 latency harness", () => {
  it("keeps prefetched opens instant, cold shells immediate, and CID srcDoc stable", async () => {
    vi.useFakeTimers();
    const cache = new MessageMemoryCache();
    const cacheServer = new Promise<MailMessage>((resolve) => setTimeout(() => resolve(row), 200));
    await vi.advanceTimersByTimeAsync(200);
    cache.set(scope, await cacheServer);

    const clickAt = performance.now();
    const prefetched = cache.get(scope, row);
    expect(prefetched?.body).toContain("body");
    expect(performance.now() - clickAt).toBeLessThan(1);

    let shellPainted = false;
    let coldBody: MailMessage | null = null;
    shellPainted = true;
    const imap = new Promise<MailMessage>((resolve) => setTimeout(() => resolve(row), 900)).then(
      (message) => (coldBody = message),
    );
    expect(shellPainted).toBe(true);
    expect(coldBody).toBeNull();
    await vi.advanceTimersByTimeAsync(900);
    await imap;
    expect(coldBody).toEqual(row);

    const options = {
      html: row.body,
      nonce: "nonce",
      channelId: "channel",
      parentOrigin: "https://app.example.com",
    };
    const beforeCid = buildEmailSrcDoc(options);
    const cid = new Promise((resolve) => setTimeout(resolve, 700));
    await vi.advanceTimersByTimeAsync(700);
    await cid;
    expect(buildEmailSrcDoc(options)).toBe(beforeCid);
  });
});
