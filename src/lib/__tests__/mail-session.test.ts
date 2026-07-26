import { describe, it, expect, beforeEach } from "vitest";

// jsdom-style shim for sessionStorage in node.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

// Node's ESM has no window; polyfill before importing module under test.
(globalThis as any).window = globalThis;
(globalThis as any).sessionStorage = new MemStorage();
(globalThis as any).localStorage = new MemStorage();

const mod = await import("../mail-session");

const baseAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  company_id: "22222222-2222-4222-8222-222222222222",
  email_address: "u@a.com",
  display_name: null,
  imap_host: "h", imap_port: 993, imap_secure: true,
  smtp_host: "h", smtp_port: 465, smtp_secure: true,
};

beforeEach(() => {
  (globalThis as any).sessionStorage.clear();
  (globalThis as any).localStorage.clear();
});

describe("mail-session", () => {
  it("saves and restores token", () => {
    mod.saveMailSession({
      account: baseAccount, company: null, password: "pw",
      mailSessionToken: "abc.def.ghi", mailSessionTokenExpiresAt: 999,
    });
    const s = mod.getMailSession();
    expect(s?.mailSessionToken).toBe("abc.def.ghi");
    expect(s?.password).toBe("pw");
  });

  it("clearMailSession removes token AND password", () => {
    mod.saveMailSession({
      account: baseAccount, company: null, password: "pw", mailSessionToken: "t",
    });
    mod.clearMailSession();
    const raw = (globalThis as any).sessionStorage.getItem("mailmaestro.mail.session");
    expect(raw).toBeNull();
    expect(mod.getMailSession()).toBeNull();
  });

  it("legacy session without token does not crash", () => {
    (globalThis as any).sessionStorage.setItem(
      "mailmaestro.mail.session",
      JSON.stringify({ account: baseAccount, company: null, password: "pw" }),
    );
    const s = mod.getMailSession();
    expect(s).not.toBeNull();
    expect(s?.mailSessionToken).toBeUndefined();
  });

  it("token is not written to localStorage", () => {
    mod.saveMailSession({
      account: baseAccount, company: null, password: "pw", mailSessionToken: "t",
    });
    // no writes to localStorage
    expect((globalThis as any).localStorage.getItem("mailmaestro.mail.session")).toBeNull();
  });
});
