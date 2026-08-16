// Draft save/delete PII-safe timing instrumentation — regression guards.
// Reads the Bridge source directly (read-only, no runtime bridge needed).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const drafts = () => readFileSync(new URL("../../../bridge/src/drafts.ts", import.meta.url), "utf8");
const index = () => readFileSync(new URL("../../../bridge/src/index.ts", import.meta.url), "utf8");

describe("draft save timing instrumentation", () => {
  it("emits save phase timings", () => {
    const src = drafts();
    expect(src).toContain('op=${op} phase=${phase} ms=');
    expect(src).toContain('t.mark("mutex-wait")');
    expect(src).toContain('t.mark("connect")');
    expect(src).toContain('t.mark("list")');
    expect(src).toContain('t.mark("spool")');
    expect(src).toContain('t.mark("buffer-read")');
    expect(src).toContain('t.mark("append")');
  });

  it("gates every log behind TIMING_ENABLED", () => {
    const src = drafts();
    expect(src).toContain("if (TIMING_ENABLED)");
    expect(src).toContain("if (!TIMING_ENABLED) return;");
  });
});

describe("draft delete timing instrumentation", () => {
  it("emits delete phase timings + a coarse error code", () => {
    const src = drafts();
    expect(src).toContain('t.mark("mutex-wait")');
    expect(src).toContain('t.mark("mailbox-lock")');
    expect(src).toContain('t.mark("header-search")');
    expect(src).toContain('t.mark("delete")');
    expect(src).toContain('t.finish("error", "code=IMAP_ERROR")');
  });

  it("logs the previously-silent /api/draft-delete failure when timing is on", () => {
    const src = index();
    expect(src).toContain('[draft-timing] op=delete status=error code=');
  });
});

describe("instrumentation PII safety", () => {
  it("the phase timer template carries no identity fields", () => {
    const src = drafts();
    const start = src.indexOf("function createDraftPhaseTimer");
    const end = src.indexOf("// --- IMAP capability detection", start);
    const timerFn = src.slice(start, end);
    for (const pii of [
      "email",
      "draftId",
      "uid",
      "uidValidity",
      "uidvalidity",
      "subject",
      "recipient",
      "filename",
      "messageId",
      "message_id",
      "password",
      "account",
    ]) {
      expect(timerFn, `timer must not reference ${pii}`).not.toContain(pii);
    }
  });
});
