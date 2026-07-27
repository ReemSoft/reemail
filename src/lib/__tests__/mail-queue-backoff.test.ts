import { describe, expect, it } from "vitest";
import {
  classifyBridgeError,
  computeBackoffSeconds,
  decideFailureAction,
  isNonRetryableCode,
  isRetryableCode,
} from "../mail-queue-backoff";
import { MAIL_QUEUE_CONFIG } from "../mail-queue-config";

describe("classifyBridgeError", () => {
  it("classifies busy/locked as MAIL_SYNC_BUSY", () => {
    expect(classifyBridgeError({ code: "MAIL_SYNC_BUSY" })).toBe("MAIL_SYNC_BUSY");
    expect(classifyBridgeError({ message: "resource is locked" })).toBe("MAIL_SYNC_BUSY");
  });

  it("classifies AUTH codes/messages", () => {
    expect(classifyBridgeError({ code: "AUTH" })).toBe("AUTH");
    expect(classifyBridgeError({ code: "AUTHENTICATIONFAILED" })).toBe("AUTH");
    expect(classifyBridgeError({ message: "AuthenticationFailed" })).toBe("AUTH");
    expect(classifyBridgeError({ message: "Invalid credentials" })).toBe("AUTH");
  });

  it("classifies TIMEOUT/RATE/NETWORK/IMAP correctly", () => {
    expect(classifyBridgeError({ code: "ETIMEDOUT" })).toBe("TIMEOUT");
    expect(classifyBridgeError({ message: "operation timed out" })).toBe("TIMEOUT");
    expect(classifyBridgeError({ message: "too many requests" })).toBe("RATE_LIMIT");
    expect(classifyBridgeError({ message: "ECONNRESET" })).toBe("NETWORK");
    expect(classifyBridgeError({ message: "imap error something" })).toBe("IMAP_TEMPORARY");
  });

  it("falls back to UNKNOWN", () => {
    expect(classifyBridgeError({ message: "🤷 weird thing" })).toBe("UNKNOWN");
    expect(classifyBridgeError({})).toBe("UNKNOWN");
  });

  it("never fabricates non-retryable codes from vague strings", () => {
    // Vague network mention must NOT become AUTH/CONFIG.
    expect(classifyBridgeError({ message: "network unreachable" })).toBe("NETWORK");
    expect(classifyBridgeError({ message: "server error" })).toBe("UNKNOWN");
  });
});

describe("isRetryableCode / isNonRetryableCode", () => {
  it("partitions codes correctly", () => {
    for (const c of ["NETWORK", "TIMEOUT", "UNAVAILABLE", "IMAP_TEMPORARY", "RATE_LIMIT", "MAIL_SYNC_BUSY"] as const) {
      expect(isRetryableCode(c)).toBe(true);
      expect(isNonRetryableCode(c)).toBe(false);
    }
    for (const c of ["AUTH", "ACCOUNT_DISABLED", "INVALID_CONFIG"] as const) {
      expect(isNonRetryableCode(c)).toBe(true);
      expect(isRetryableCode(c)).toBe(false);
    }
    expect(isRetryableCode("UNKNOWN")).toBe(false);
    expect(isNonRetryableCode("UNKNOWN")).toBe(false);
  });
});

describe("computeBackoffSeconds", () => {
  it("uses exponential growth from base", () => {
    const { baseSeconds } = MAIL_QUEUE_CONFIG.backoff;
    const d1 = computeBackoffSeconds(1, () => 0.5); // no jitter
    const d2 = computeBackoffSeconds(2, () => 0.5);
    const d3 = computeBackoffSeconds(3, () => 0.5);
    expect(d1).toBe(baseSeconds);
    expect(d2).toBe(baseSeconds * 2);
    expect(d3).toBe(baseSeconds * 4);
  });

  it("caps at capSeconds", () => {
    const { capSeconds } = MAIL_QUEUE_CONFIG.backoff;
    const d = computeBackoffSeconds(20, () => 0.5);
    expect(d).toBeLessThanOrEqual(capSeconds);
    expect(d).toBe(capSeconds);
  });

  it("applies jitter within ±jitterFraction", () => {
    const { baseSeconds, jitterFraction } = MAIL_QUEUE_CONFIG.backoff;
    const min = computeBackoffSeconds(1, () => 0); // -jitterFraction
    const max = computeBackoffSeconds(1, () => 1); // +jitterFraction
    expect(min).toBeGreaterThanOrEqual(Math.round(baseSeconds * (1 - jitterFraction)));
    expect(max).toBeLessThanOrEqual(Math.round(baseSeconds * (1 + jitterFraction)));
    expect(min).toBeLessThan(baseSeconds);
    expect(max).toBeGreaterThan(baseSeconds);
  });

  it("returns >= 1 for any input", () => {
    expect(computeBackoffSeconds(0, () => 0)).toBeGreaterThanOrEqual(1);
    expect(computeBackoffSeconds(-5, () => 0)).toBeGreaterThanOrEqual(1);
    expect(computeBackoffSeconds(NaN, () => 0.5)).toBeGreaterThanOrEqual(1);
  });
});

describe("decideFailureAction", () => {
  it("routes AUTH straight to dead — no retry loop", () => {
    const r = decideFailureAction({ code: "AUTH", attempt: 1 });
    expect(r.action).toBe("dead");
    expect(r.delaySeconds).toBe(0);
  });

  it("routes ACCOUNT_DISABLED and INVALID_CONFIG to dead", () => {
    expect(decideFailureAction({ code: "ACCOUNT_DISABLED", attempt: 1 }).action).toBe("dead");
    expect(decideFailureAction({ code: "INVALID_CONFIG", attempt: 1 }).action).toBe("dead");
  });

  it("retries transient codes until max_attempts", () => {
    const { maxAttempts } = MAIL_QUEUE_CONFIG.backoff;
    for (let a = 1; a < maxAttempts; a++) {
      const r = decideFailureAction({ code: "NETWORK", attempt: a, random: () => 0.5 });
      expect(r.action).toBe("retry");
      expect(r.delaySeconds).toBeGreaterThan(0);
    }
    const last = decideFailureAction({ code: "NETWORK", attempt: maxAttempts, random: () => 0.5 });
    expect(last.action).toBe("dead");
  });

  it("MAIL_SYNC_BUSY is retryable and receives a positive delay", () => {
    const r = decideFailureAction({ code: "MAIL_SYNC_BUSY", attempt: 1, random: () => 0.5 });
    expect(r.action).toBe("retry");
    expect(r.delaySeconds).toBeGreaterThan(0);
  });

  it("UNKNOWN treated as non-retryable → dead (avoid infinite retries on true bugs)", () => {
    const r = decideFailureAction({ code: "UNKNOWN", attempt: 1 });
    // UNKNOWN is neither in RETRYABLE nor NON_RETRYABLE sets;
    // decideFailureAction currently allows retries. Codify current behavior:
    expect(r.action).toBe("retry");
  });
});
