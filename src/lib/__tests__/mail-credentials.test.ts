import { describe, it, expect, beforeEach } from "vitest";
import {
  persistCredentialsAfterSuccessfulVerify,
  loadDecryptedPasswordForAccount,
  clearCredentialsForAccount,
  readCredentialStatus,
  MailCredentialsPendingError,
} from "../mail-credentials.server";
import {
  __resetKeyCacheForTests,
  __seedKeyForTests,
  CURRENT_MAIL_KEY_VERSION,
  constantTimeEquals,
} from "../mail-crypto.server";
import { randomBytes } from "node:crypto";

const ACC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

interface Row {
  id: string;
  company_id: string;
  credentials_ciphertext: string | null;
  credentials_key_version: number | null;
  credentials_updated_at: string | null;
}

function makeFakeAdmin(rows: Row[]) {
  return {
    rpc: async () => ({ data: null, error: { code: "SHOULD_NOT_BE_CALLED" } }),
    from(table: string) {
      if (table !== "mail_accounts") throw new Error("unexpected " + table);
      const state: {
        op: "select" | "update" | "";
        filters: Array<[string, unknown]>;
        payload?: Partial<Row>;
        selectCols?: string;
      } = { op: "", filters: [] };
      const api: any = {
        select(cols: string) {
          state.op = "select";
          state.selectCols = cols;
          return api;
        },
        update(payload: Partial<Row>) {
          state.op = "update";
          state.payload = payload;
          return api;
        },
        eq(col: string, val: unknown) {
          state.filters.push([col, val]);
          return api;
        },
        async maybeSingle() {
          const found = rows.find((r) =>
            state.filters.every(([c, v]) => (r as any)[c] === v),
          );
          return { data: found ?? null, error: null };
        },
        // Update terminator (no await on chain root — supabase returns awaitable)
        then(resolve: (v: any) => void, reject: (e: any) => void) {
          try {
            const idx = rows.findIndex((r) =>
              state.filters.every(([c, v]) => (r as any)[c] === v),
            );
            if (idx === -1) return resolve({ error: null, data: null });
            rows[idx] = { ...rows[idx], ...(state.payload ?? {}) } as Row;
            resolve({ error: null, data: null });
          } catch (e) {
            reject(e);
          }
        },
      };
      return api;
    },
  } as any;
}

describe("mail-credentials: encrypt → persist → decrypt round-trip", () => {
  beforeEach(() => {
    __resetKeyCacheForTests();
    __seedKeyForTests(CURRENT_MAIL_KEY_VERSION, randomBytes(32));
  });

  it("stores ciphertext + version on persist and returns plaintext on load", async () => {
    const rows: Row[] = [
      {
        id: ACC,
        company_id: CID,
        credentials_ciphertext: null,
        credentials_key_version: null,
        credentials_updated_at: null,
      },
    ];
    const admin = makeFakeAdmin(rows);
    const pw = "🔑 my-imap-password 2026!";
    const { keyVersion } = await persistCredentialsAfterSuccessfulVerify(admin, ACC, CID, pw);
    expect(keyVersion).toBe(CURRENT_MAIL_KEY_VERSION);
    expect(rows[0].credentials_ciphertext).toMatch(/^v1:/);
    expect(rows[0].credentials_key_version).toBe(CURRENT_MAIL_KEY_VERSION);
    expect(rows[0].credentials_updated_at).toBeTruthy();
    // Ciphertext must not contain the plaintext.
    expect(rows[0].credentials_ciphertext).not.toContain("my-imap-password");
    const loaded = await loadDecryptedPasswordForAccount(admin, ACC, CID);
    expect(constantTimeEquals(loaded, pw)).toBe(true);
  });

  it("replaces prior ciphertext on re-persist (password change)", async () => {
    const rows: Row[] = [
      {
        id: ACC,
        company_id: CID,
        credentials_ciphertext: null,
        credentials_key_version: null,
        credentials_updated_at: null,
      },
    ];
    const admin = makeFakeAdmin(rows);
    await persistCredentialsAfterSuccessfulVerify(admin, ACC, CID, "oldpw");
    const before = rows[0].credentials_ciphertext;
    await persistCredentialsAfterSuccessfulVerify(admin, ACC, CID, "newpw");
    const after = rows[0].credentials_ciphertext;
    expect(after).not.toEqual(before);
    const loaded = await loadDecryptedPasswordForAccount(admin, ACC, CID);
    expect(constantTimeEquals(loaded, "newpw")).toBe(true);
  });

  it("throws MailCredentialsPendingError when no ciphertext exists", async () => {
    const rows: Row[] = [
      {
        id: ACC,
        company_id: CID,
        credentials_ciphertext: null,
        credentials_key_version: null,
        credentials_updated_at: null,
      },
    ];
    const admin = makeFakeAdmin(rows);
    await expect(loadDecryptedPasswordForAccount(admin, ACC, CID)).rejects.toBeInstanceOf(
      MailCredentialsPendingError,
    );
  });

  it("company mismatch does not leak another company's ciphertext", async () => {
    const rows: Row[] = [
      {
        id: ACC,
        company_id: CID,
        credentials_ciphertext: "v1:aa:bb:cc",
        credentials_key_version: 1,
        credentials_updated_at: null,
      },
    ];
    const admin = makeFakeAdmin(rows);
    await expect(
      loadDecryptedPasswordForAccount(admin, ACC, "different-company"),
    ).rejects.toBeInstanceOf(MailCredentialsPendingError);
  });

  it("clearCredentialsForAccount removes ciphertext and version", async () => {
    const rows: Row[] = [
      {
        id: ACC,
        company_id: CID,
        credentials_ciphertext: null,
        credentials_key_version: null,
        credentials_updated_at: null,
      },
    ];
    const admin = makeFakeAdmin(rows);
    await persistCredentialsAfterSuccessfulVerify(admin, ACC, CID, "pw");
    expect(rows[0].credentials_ciphertext).toBeTruthy();
    await clearCredentialsForAccount(admin, ACC, CID);
    expect(rows[0].credentials_ciphertext).toBeNull();
    expect(rows[0].credentials_key_version).toBeNull();
    const status = await readCredentialStatus(admin, ACC, CID);
    expect(status.status).toBe("pending");
  });

  it("readCredentialStatus reports active after persist without exposing ciphertext", async () => {
    const rows: Row[] = [
      {
        id: ACC,
        company_id: CID,
        credentials_ciphertext: null,
        credentials_key_version: null,
        credentials_updated_at: null,
      },
    ];
    const admin = makeFakeAdmin(rows);
    await persistCredentialsAfterSuccessfulVerify(admin, ACC, CID, "pw");
    const status = await readCredentialStatus(admin, ACC, CID);
    expect(status.status).toBe("active");
    expect(status.keyVersion).toBe(CURRENT_MAIL_KEY_VERSION);
    // Status object must not carry the ciphertext field.
    expect(JSON.stringify(status)).not.toMatch(/v1:/);
  });
});
