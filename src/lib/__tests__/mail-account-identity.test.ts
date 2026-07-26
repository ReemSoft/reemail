import { describe, it, expect } from "vitest";
import {
  findOrCreateMailAccountIdentity,
  normalizeEmail,
  MailAccountOwnershipConflictError,
  MailAccountSourceMismatchError,
} from "../mail-account-identity.server";

const CID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOM_1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

interface Row {
  id: string;
  company_id: string;
  email_address: string;
  normalized_email: string;
  source_domain_id: string | null;
  display_name: string | null;
}

function makeMockAdmin(seed: Row[] = [], opts: { failFirstInsertAs?: "race" } = {}) {
  const rows: Row[] = [...seed];
  let raceArmed = opts.failFirstInsertAs === "race";
  let inserted: Row[] = [];

  function chain(table: string) {
    if (table !== "mail_accounts") throw new Error("unexpected table " + table);
    const state: { op: string; row?: any; filters: Array<[string, any]>; select?: string } = {
      op: "",
      filters: [],
    };
    const obj: any = {
      select(sel: string) {
        state.select = sel;
        return obj;
      },
      eq(col: string, val: any) {
        state.filters.push([col, val]);
        return obj;
      },
      insert(row: any) {
        state.op = "insert";
        state.row = row;
        return obj;
      },
      async maybeSingle() {
        if (state.op === "insert") {
          if (raceArmed) {
            raceArmed = false;
            // Simulate a concurrent insert landing first.
            const email = String(state.row.email_address).toLowerCase().trim();
            rows.push({
              id: "rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr",
              company_id: state.row.company_id,
              email_address: email,
              normalized_email: email,
              source_domain_id: state.row.source_domain_id ?? null,
              display_name: state.row.display_name ?? null,
            });
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          }
          const email = String(state.row.email_address).toLowerCase().trim();
          if (rows.some((r) => r.normalized_email === email)) {
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          }
          const newRow: Row = {
            id: `new-${inserted.length}-uuid-uuid-uuidxxxxxxxx`,
            company_id: state.row.company_id,
            email_address: email,
            normalized_email: email,
            source_domain_id: state.row.source_domain_id ?? null,
            display_name: state.row.display_name ?? null,
          };
          rows.push(newRow);
          inserted.push(newRow);
          return { data: newRow, error: null };
        }
        // select path
        const match = rows.find((r) => state.filters.every(([c, v]) => (r as any)[c] === v));
        return { data: match ?? null, error: null };
      },
    };
    return obj;
  }
  return {
    admin: { from: chain } as any,
    rows,
    inserted,
  };
}

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Foo@BAR.com ")).toBe("foo@bar.com");
  });
});

describe("findOrCreateMailAccountIdentity", () => {
  it("returns existing UUID for manual account", async () => {
    const seed: Row[] = [
      {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        company_id: CID_A,
        email_address: "u@a.com",
        normalized_email: "u@a.com",
        source_domain_id: null,
        display_name: null,
      },
    ];
    const { admin, inserted } = makeMockAdmin(seed);
    const r = await findOrCreateMailAccountIdentity(admin, {
      companyId: CID_A,
      emailAddress: "u@a.com",
      accountSource: "manual",
    });
    expect(r.id).toBe("ffffffff-ffff-4fff-8fff-ffffffffffff");
    expect(inserted).toHaveLength(0);
  });

  it("creates row for domain-derived account", async () => {
    const { admin, inserted } = makeMockAdmin([]);
    const r = await findOrCreateMailAccountIdentity(admin, {
      companyId: CID_A,
      emailAddress: "new@a.com",
      accountSource: "domain",
      sourceDomainId: DOM_1,
    });
    expect(inserted).toHaveLength(1);
    expect(r.sourceDomainId).toBe(DOM_1);
    expect(r.normalizedEmail).toBe("new@a.com");
  });

  it("case/whitespace variants resolve to same row", async () => {
    const { admin, inserted } = makeMockAdmin([]);
    const first = await findOrCreateMailAccountIdentity(admin, {
      companyId: CID_A,
      emailAddress: "  User@A.com ",
      accountSource: "manual",
    });
    const second = await findOrCreateMailAccountIdentity(admin, {
      companyId: CID_A,
      emailAddress: "user@a.com",
      accountSource: "manual",
    });
    expect(second.id).toBe(first.id);
    expect(inserted).toHaveLength(1);
  });

  it("cross-company conflict throws typed error and does not leak", async () => {
    const seed: Row[] = [
      {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        company_id: CID_A,
        email_address: "x@a.com",
        normalized_email: "x@a.com",
        source_domain_id: null,
        display_name: null,
      },
    ];
    const { admin } = makeMockAdmin(seed);
    await expect(
      findOrCreateMailAccountIdentity(admin, {
        companyId: CID_B,
        emailAddress: "x@a.com",
        accountSource: "manual",
      }),
    ).rejects.toBeInstanceOf(MailAccountOwnershipConflictError);
  });

  it("simulated race does not create two rows", async () => {
    const { admin, rows } = makeMockAdmin([], { failFirstInsertAs: "race" });
    const r = await findOrCreateMailAccountIdentity(admin, {
      companyId: CID_A,
      emailAddress: "race@a.com",
      accountSource: "manual",
    });
    expect(r.id).toBeDefined();
    expect(rows.filter((x) => x.normalized_email === "race@a.com")).toHaveLength(1);
  });

  it("source_domain_id mismatch on domain re-login throws typed error", async () => {
    const OTHER_DOM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const seed: Row[] = [
      {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        company_id: CID_A,
        email_address: "d@a.com",
        normalized_email: "d@a.com",
        source_domain_id: OTHER_DOM,
        display_name: null,
      },
    ];
    const { admin } = makeMockAdmin(seed);
    await expect(
      findOrCreateMailAccountIdentity(admin, {
        companyId: CID_A,
        emailAddress: "d@a.com",
        accountSource: "domain",
        sourceDomainId: DOM_1,
      }),
    ).rejects.toBeInstanceOf(MailAccountSourceMismatchError);
  });

  it("manual login for existing domain-derived row keeps source_domain_id", async () => {
    const seed: Row[] = [
      {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        company_id: CID_A,
        email_address: "m@a.com",
        normalized_email: "m@a.com",
        source_domain_id: DOM_1,
        display_name: null,
      },
    ];
    const { admin } = makeMockAdmin(seed);
    const r = await findOrCreateMailAccountIdentity(admin, {
      companyId: CID_A,
      emailAddress: "m@a.com",
      accountSource: "manual",
    });
    expect(r.sourceDomainId).toBe(DOM_1);
  });
});
