import { describe, it, expect } from "vitest";
import {
  MailAccountCompanyMismatchError,
  MailAccountNotFoundError,
  MailConfigIncompleteError,
  resolveMailConfigForAccount,
} from "../mail-config.server";

const ACC = "11111111-1111-4111-8111-111111111111";
const CID = "22222222-2222-4222-8222-222222222222";
const OTHER_CID = "99999999-9999-4999-8999-999999999999";
const DID = "33333333-3333-4333-8333-333333333333";

type AccountRow = {
  id: string;
  company_id: string;
  email_address: string;
  normalized_email: string | null;
  display_name: string | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_secure: boolean | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean | null;
  source_domain_id: string | null;
};

type DomainRow = {
  id: string;
  company_id: string;
  domain: string;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
};

function makeAdmin(accounts: AccountRow[], domains: DomainRow[] = []) {
  const admin = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const state: { table: string; ilike?: [string, string] } = { table };
      const chain: Record<string, unknown> = {
        select() {
          return chain;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return chain;
        },
        ilike(col: string, val: string) {
          state.ilike = [col, val.toLowerCase()];
          return chain;
        },
        limit() {
          return chain;
        },
        async maybeSingle() {
          if (table === "mail_accounts") {
            const row = accounts.find(
              (r) => r.id === filters.id && (filters.company_id ? r.company_id === filters.company_id : true),
            );
            return { data: row ?? null, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve: (v: unknown) => void) {
          // list query for email_domains
          if (table === "email_domains") {
            let rows = domains.filter(
              (d) => !filters.company_id || d.company_id === filters.company_id,
            );
            if (filters.id) rows = rows.filter((d) => d.id === filters.id);
            if (state.ilike) {
              const [, needle] = state.ilike;
              rows = rows.filter((d) => d.domain.toLowerCase() === needle);
            }
            resolve({ data: rows, error: null });
            return;
          }
          resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  } as unknown as Parameters<typeof resolveMailConfigForAccount>[0];
  return admin;
}

function fullAccount(): AccountRow {
  return {
    id: ACC,
    company_id: CID,
    email_address: "user@example.com",
    normalized_email: "user@example.com",
    display_name: "User",
    imap_host: "imap.example.com",
    imap_port: 993,
    imap_secure: true,
    smtp_host: "smtp.example.com",
    smtp_port: 465,
    smtp_secure: true,
    source_domain_id: null,
  };
}

describe("resolveMailConfigForAccount", () => {
  it("returns full config when the account row is complete", async () => {
    const admin = makeAdmin([fullAccount()]);
    const cfg = await resolveMailConfigForAccount(admin, ACC, CID);
    expect(cfg.emailAddress).toBe("user@example.com");
    expect(cfg.imapHost).toBe("imap.example.com");
    expect(cfg.smtpPort).toBe(465);
    expect(cfg.companyId).toBe(CID);
  });

  it("throws MailAccountNotFoundError when the row is missing", async () => {
    const admin = makeAdmin([]);
    await expect(resolveMailConfigForAccount(admin, ACC, CID)).rejects.toBeInstanceOf(
      MailAccountNotFoundError,
    );
  });

  it("rejects a company mismatch (spoofed cid claim)", async () => {
    const admin = makeAdmin([fullAccount()]);
    await expect(
      resolveMailConfigForAccount(admin, ACC, OTHER_CID),
    ).rejects.toBeInstanceOf(MailAccountCompanyMismatchError);
  });

  it("fills missing IMAP/SMTP from a same-company domain row", async () => {
    const acc = fullAccount();
    acc.imap_host = null;
    acc.imap_port = null;
    acc.imap_secure = null;
    acc.smtp_host = null;
    acc.smtp_port = null;
    acc.smtp_secure = null;
    acc.source_domain_id = DID;
    const domain: DomainRow = {
      id: DID,
      company_id: CID,
      domain: "example.com",
      imap_host: "imap.example.com",
      imap_port: 993,
      imap_secure: true,
      smtp_host: "smtp.example.com",
      smtp_port: 587,
      smtp_secure: false,
    };
    const admin = makeAdmin([acc], [domain]);
    const cfg = await resolveMailConfigForAccount(admin, ACC, CID);
    expect(cfg.imapHost).toBe("imap.example.com");
    expect(cfg.smtpPort).toBe(587);
    expect(cfg.smtpSecure).toBe(false);
  });

  it("throws MailConfigIncompleteError when neither account nor domain covers all fields", async () => {
    const acc = fullAccount();
    acc.imap_host = null;
    acc.smtp_host = null;
    const admin = makeAdmin([acc], []);
    await expect(resolveMailConfigForAccount(admin, ACC, CID)).rejects.toBeInstanceOf(
      MailConfigIncompleteError,
    );
  });
});
