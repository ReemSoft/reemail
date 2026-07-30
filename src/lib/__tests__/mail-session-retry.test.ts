import { describe, it, expect, vi } from "vitest";
import {
  isSessionExpiredResult,
  isSessionExpiredError,
  withFreshToken,
  createSingleFlightRenewer,
  callWithSessionRetry,
} from "../mail-session-retry";

describe("session expiry detection", () => {
  it("detects INVALID_TOKEN results", () => {
    expect(isSessionExpiredResult({ ok: false, code: "INVALID_TOKEN" })).toBe(true);
    expect(isSessionExpiredResult({ ok: false, code: "NETWORK" })).toBe(false);
    expect(isSessionExpiredResult({ ok: true })).toBe(false);
    expect(isSessionExpiredResult(null)).toBe(false);
  });

  it("detects thrown expiry errors", () => {
    expect(isSessionExpiredError(Object.assign(new Error("x"), { code: "INVALID_TOKEN" }))).toBe(true);
    expect(isSessionExpiredError(new Error("MAIL_SESSION_EXPIRED at bridge"))).toBe(true);
    expect(isSessionExpiredError(new Error("boom"))).toBe(false);
  });
});

describe("withFreshToken", () => {
  it("rewrites the flat token", () => {
    const out = withFreshToken({ data: { mailSessionToken: "old", uid: 1 } }, "new");
    expect(out.data.mailSessionToken).toBe("new");
    expect(out.data.uid).toBe(1);
  });
  it("rewrites nested payload tokens", () => {
    const out = withFreshToken({ data: { draft: { mailSessionToken: "old", to: "a@b.c" } } }, "new") as any;
    expect(out.data.draft.mailSessionToken).toBe("new");
    expect(out.data.draft.to).toBe("a@b.c");
  });
  it("leaves unrelated args untouched", () => {
    const arg = { data: { uid: 3 } };
    expect(withFreshToken(arg, "new")).toBe(arg);
  });
});

describe("createSingleFlightRenewer", () => {
  it("shares one in-flight renewal", async () => {
    let calls = 0;
    const renew = createSingleFlightRenewer(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return "tok";
    });
    const [a, b] = await Promise.all([renew(), renew()]);
    expect(calls).toBe(1);
    expect(a).toBe("tok");
    expect(b).toBe("tok");
    await renew();
    expect(calls).toBe(2);
  });
});

describe("callWithSessionRetry", () => {
  it("passes through successful calls", async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const renew = vi.fn();
    const res = await callWithSessionRetry(call, { data: {} }, { renew });
    expect(res).toEqual({ ok: true });
    expect(renew).not.toHaveBeenCalled();
  });

  it("renews once and retries with the fresh token", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: "INVALID_TOKEN" })
      .mockResolvedValueOnce({ ok: true });
    const renew = vi.fn().mockResolvedValue("fresh");
    const res = await callWithSessionRetry(
      call,
      { data: { mailSessionToken: "old" } },
      { renew },
    );
    expect(res).toEqual({ ok: true });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0].data.mailSessionToken).toBe("fresh");
  });

  it("signals expiry and returns the original result when renewal fails", async () => {
    const call = vi.fn().mockResolvedValue({ ok: false, code: "INVALID_TOKEN" });
    const onRenewFailed = vi.fn();
    const res = await callWithSessionRetry(
      call,
      { data: { mailSessionToken: "old" } },
      { renew: async () => null, onRenewFailed },
    );
    expect(res).toEqual({ ok: false, code: "INVALID_TOKEN" });
    expect(onRenewFailed).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rethrows non-session errors without renewing", async () => {
    const renew = vi.fn();
    await expect(
      callWithSessionRetry(async () => {
        throw new Error("boom");
      }, {}, { renew }),
    ).rejects.toThrow("boom");
    expect(renew).not.toHaveBeenCalled();
  });
});
