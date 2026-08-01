import { describe, it, expect, beforeEach } from "vitest";
import type { MailSession } from "@/lib/mail-session";

// Node's ESM has no window; polyfill before importing module under test.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
(globalThis as any).window = globalThis;
(globalThis as any).sessionStorage = new MemStorage();

const {
  clearMailSession,
  getMailSession,
  listPooledMailboxes,
  removePooledMailbox,
  saveMailSession,
  setActiveMailbox,
} = await import("@/lib/mail-session");


function mk(id: string, email: string): MailSession {
  return {
    account: {
      id,
      company_id: "c1",
      email_address: email,
      display_name: null,
      imap_host: "imap.x",
      imap_port: 993,
      imap_secure: true,
      smtp_host: "smtp.x",
      smtp_port: 465,
      smtp_secure: true,
    },
    company: null,
    password: "pw-" + id,
    mailSessionToken: "t-" + id,
    mailSessionTokenExpiresAt: 9999999999,
  };
}

describe("mailbox pool (Phase B)", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("adds the active mailbox to the pool", () => {
    saveMailSession(mk("a", "a@x.com"));
    expect(listPooledMailboxes().map((m) => m.account.id)).toEqual(["a"]);
  });

  it("keeps one entry per account and switches the active mailbox", () => {
    saveMailSession(mk("a", "a@x.com"));
    setActiveMailbox(mk("b", "b@x.com"));
    setActiveMailbox(mk("b", "b@x.com"));
    expect(listPooledMailboxes().map((m) => m.account.id).sort()).toEqual(["a", "b"]);
    expect(getMailSession()?.account.id).toBe("b");
  });

  it("removes a pooled mailbox without touching the active one", () => {
    saveMailSession(mk("a", "a@x.com"));
    setActiveMailbox(mk("b", "b@x.com"));
    removePooledMailbox("a");
    expect(listPooledMailboxes().map((m) => m.account.id)).toEqual(["b"]);
    expect(getMailSession()?.account.id).toBe("b");
  });

  it("wipes every mailbox password on sign-out", () => {
    saveMailSession(mk("a", "a@x.com"));
    setActiveMailbox(mk("b", "b@x.com"));
    clearMailSession();
    expect(listPooledMailboxes()).toEqual([]);
    expect(getMailSession()).toBeNull();
  });
});
