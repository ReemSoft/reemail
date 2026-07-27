import { describe, it, expect, vi } from "vitest";
import {
  processClaimedJob,
  processClaimedBatch,
  type WorkerClaimedJob,
} from "../mail-worker-runner.server";

// ------------------------- Fakes -------------------------

type RpcCall = { fn: string; args: unknown };

function makeAdmin(opts: {
  folderRow?: { path: string; canonical: string | null } | null;
} = {}) {
  const calls: RpcCall[] = [];
  const admin = {
    from(table: string) {
      if (table !== "mail_folders") throw new Error("unexpected table " + table);
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        maybeSingle: async () => ({
                          data: opts.folderRow ?? null,
                          error: null,
                        }),
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    rpc(fn: string, args: unknown) {
      calls.push({ fn, args });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { admin: admin as never, calls };
}

// Silence expected server-side error logs from the credential/config layer.
vi.mock("@/lib/mail-credentials.server", () => {
  class MailCredentialsPendingError extends Error {
    code = "MAIL_CREDENTIALS_PENDING" as const;
    constructor() {
      super("MAIL_CREDENTIALS_PENDING");
    }
  }
  return {
    MailCredentialsPendingError,
    loadDecryptedPasswordForAccount: vi
      .fn()
      .mockResolvedValue("decrypted-password-xxx"),
  };
});

vi.mock("@/lib/mail-config.server", () => {
  class MailConfigIncompleteError extends Error {
    code = "MAIL_CONFIG_INCOMPLETE" as const;
    constructor() {
      super("MAIL_CONFIG_INCOMPLETE");
    }
  }
  return {
    MailConfigIncompleteError,
    resolveMailConfigForAccount: vi.fn().mockResolvedValue({
      accountId: "acc-1",
      companyId: "co-1",
      emailAddress: "u@example.com",
      normalizedEmail: "u@example.com",
      displayName: null,
      imapHost: "imap.example.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp.example.com",
      smtpPort: 465,
      smtpSecure: true,
      sourceDomainId: null,
    }),
  };
});

const runMailSyncCoreMock = vi.fn();
vi.mock("@/lib/mail-sync-runner.server", () => ({
  runMailSyncCore: (...args: unknown[]) => runMailSyncCoreMock(...args),
}));

function makeJob(overrides: Partial<WorkerClaimedJob["message"]> = {}, readCt = 1): WorkerClaimedJob {
  return {
    msg_id: 42,
    read_ct: readCt,
    message: {
      company_id: "co-1",
      account_id: "acc-1",
      folder_id: "fld-1",
      kind: "incremental",
      folder_path: "INBOX",
      ...overrides,
    },
  };
}

// ------------------------- Tests -------------------------

describe("processClaimedJob", () => {
  it("marks job completed on ok:true, non-busy result", async () => {
    runMailSyncCoreMock.mockResolvedValueOnce({
      ok: true,
      busy: false,
      wroteMessages: 12,
      total: 200,
      unread: 3,
    });
    const { admin, calls } = makeAdmin();
    const out = await processClaimedJob(
      { admin, workerId: "w1" },
      makeJob(),
    );
    expect(out.kind).toBe("completed");
    expect(calls.some((c) => c.fn === "complete_mail_sync_job")).toBe(true);
  });

  it("retries with backoff when the folder is busy", async () => {
    runMailSyncCoreMock.mockResolvedValueOnce({
      ok: true,
      busy: true,
      reason: "LOCKED",
    });
    const { admin, calls } = makeAdmin();
    const out = await processClaimedJob({ admin, workerId: "w1" }, makeJob());
    expect(out.kind).toBe("retried");
    if (out.kind === "retried") expect(out.code).toBe("MAIL_SYNC_BUSY");
    expect(calls.some((c) => c.fn === "fail_mail_sync_job")).toBe(true);
  });

  it("classifies retryable transport errors and requeues them", async () => {
    runMailSyncCoreMock.mockResolvedValueOnce({
      ok: false,
      error: "connection refused",
      code: "NETWORK",
    });
    const { admin, calls } = makeAdmin();
    const out = await processClaimedJob({ admin, workerId: "w1" }, makeJob({}, 1));
    expect(out.kind).toBe("retried");
    if (out.kind === "retried") {
      expect(["NETWORK", "IMAP_TEMPORARY"]).toContain(out.code);
      expect(out.delaySeconds).toBeGreaterThan(0);
    }
    const failCall = calls.find((c) => c.fn === "fail_mail_sync_job");
    expect(failCall).toBeTruthy();
    expect((failCall!.args as { p_action: string }).p_action).toBe("retry");
  });

  it("routes AUTH errors directly to dead-letter (non-retryable)", async () => {
    runMailSyncCoreMock.mockResolvedValueOnce({
      ok: false,
      error: "AUTHENTICATIONFAILED",
      code: "AUTH",
    });
    const { admin, calls } = makeAdmin();
    const out = await processClaimedJob({ admin, workerId: "w1" }, makeJob({}, 1));
    expect(out.kind).toBe("dead");
    const failCall = calls.find((c) => c.fn === "fail_mail_sync_job");
    expect(failCall).toBeTruthy();
    expect((failCall!.args as { p_action: string }).p_action).toBe("dead");
    expect((failCall!.args as { p_error_code: string }).p_error_code).toBe("AUTH");
  });

  it("resolves folder path from mail_folders when payload omits folder_path", async () => {
    runMailSyncCoreMock.mockResolvedValueOnce({
      ok: true,
      busy: false,
      wroteMessages: 0,
      total: 0,
      unread: 0,
    });
    const { admin } = makeAdmin({
      folderRow: { path: "INBOX.Sent", canonical: "sent" },
    });
    const job = makeJob();
    delete job.message.folder_path;
    const out = await processClaimedJob({ admin, workerId: "w1" }, job);
    expect(out.kind).toBe("completed");
    // runner must have been called with the resolved folder path
    const lastCall = runMailSyncCoreMock.mock.calls.at(-1)!;
    expect((lastCall[1] as { folderPath: string }).folderPath).toBe("INBOX.Sent");
  });

  it("deads immediately when folder row is missing (INVALID_CONFIG)", async () => {
    const { admin, calls } = makeAdmin({ folderRow: null });
    const job = makeJob();
    delete job.message.folder_path;
    const out = await processClaimedJob({ admin, workerId: "w1" }, job);
    expect(out.kind).toBe("dead");
    if (out.kind === "dead") expect(out.code).toBe("INVALID_CONFIG");
    const failCall = calls.find((c) => c.fn === "fail_mail_sync_job");
    expect((failCall!.args as { p_action: string }).p_action).toBe("dead");
  });
});

describe("processClaimedBatch", () => {
  it("processes jobs with bounded concurrency and collects outcomes", async () => {
    runMailSyncCoreMock.mockReset();
    runMailSyncCoreMock.mockResolvedValue({
      ok: true,
      busy: false,
      wroteMessages: 1,
      total: 1,
      unread: 0,
    });
    const { admin } = makeAdmin();
    const jobs = Array.from({ length: 5 }, (_, i) =>
      makeJob({ folder_id: `f-${i}` }),
    );
    const outcomes = await processClaimedBatch(
      { admin, workerId: "w1" },
      jobs,
      2,
    );
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((o) => o.kind === "completed")).toBe(true);
  });
});
