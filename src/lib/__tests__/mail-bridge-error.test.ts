// Ghost-cleanup contract tests.
//
// Locks the classification rules the UI relies on to decide whether a
// failed `bridgeGetMessage` may tombstone a Local Mail Index row. Only
// NOT_FOUND is allowed to trigger a `tombstoneGhostMessage` call — every
// other code (NETWORK, UNAUTHORIZED, UNAVAILABLE, UNKNOWN) MUST NOT delete
// the row, evict cache, or decrement counters.
import { describe, it, expect } from "vitest";
import { classifyBridgeMessageFailure } from "@/lib/mail-bridge-error";

describe("classifyBridgeMessageFailure — bridge /api/message error mapping", () => {
  it("HTTP 404 -> NOT_FOUND (the only code allowed to tombstone)", () => {
    expect(classifyBridgeMessageFailure({ status: 404 })).toBe("NOT_FOUND");
  });

  it("HTTP 401 -> UNAUTHORIZED (never tombstoned)", () => {
    expect(classifyBridgeMessageFailure({ status: 401 })).toBe("UNAUTHORIZED");
  });

  it("HTTP 403 -> UNAUTHORIZED (never tombstoned)", () => {
    expect(classifyBridgeMessageFailure({ status: 403 })).toBe("UNAUTHORIZED");
  });

  it("bridge unavailable flag -> UNAVAILABLE (never tombstoned)", () => {
    expect(classifyBridgeMessageFailure({ unavailable: true })).toBe("UNAVAILABLE");
    // unavailable outranks other status hints — never downgrade to NOT_FOUND.
    expect(classifyBridgeMessageFailure({ unavailable: true, status: 404 })).toBe("UNAVAILABLE");
  });

  it("missing status (fetch threw / abort) -> NETWORK, never NOT_FOUND", () => {
    expect(classifyBridgeMessageFailure({})).toBe("NETWORK");
    expect(classifyBridgeMessageFailure({ status: undefined })).toBe("NETWORK");
  });

  it("other HTTP statuses -> UNKNOWN, never NOT_FOUND", () => {
    for (const status of [500, 502, 503, 504, 418, 400, 405, 429]) {
      expect(classifyBridgeMessageFailure({ status })).toBe("UNKNOWN");
    }
  });

  it("only status===404 maps to NOT_FOUND — no near-miss aliases", () => {
    for (const status of [400, 401, 403, 405, 410, 500]) {
      expect(classifyBridgeMessageFailure({ status })).not.toBe("NOT_FOUND");
    }
  });
});
