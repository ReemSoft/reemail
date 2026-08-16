// Background stale-row convergence + no-global-sweep architecture guards.
//
// Locks:
//   * Drafts/Trash request a prompt (short-delay) bounded reconcile after
//     bootstrap instead of the normal 5-minute cadence; Inbox/Sent do not.
//   * The reconcile stays bounded by the existing 1000-UID range (no unbounded
//     full-folder scan) and one-shot per bootstrap key.
//   * onSynced / composer-close never drive a global /api/folders sweep.
//   * No hardcoded Gmail UIDVALIDITY values.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mail = () => readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");
const hook = () => readFileSync(new URL("../../hooks/use-mail-index-sync.ts", import.meta.url), "utf8");
const runner = () => readFileSync(new URL("../mail-sync-runner.server.ts", import.meta.url), "utf8");

describe("Drafts/Trash prompt background reconcile", () => {
  it("hooks a prompt reconcile for Drafts/Trash only", () => {
    const m = mail();
    expect(m).toContain('promptReconcile: folder === "drafts" || folder === "trash"');
  });

  it("schedules the first reconcile on a short delay after bootstrap", () => {
    const h = hook();
    expect(h).toContain("PROMPT_RECONCILE_MS");
    expect(h).toContain("promptReconcile ? PROMPT_RECONCILE_MS : reconcileMs");
  });

  it("is one-shot per bootstrap and bounded (existing 1000-UID range is preserved)", () => {
    const h = hook();
    expect(h).toContain("bootstrappedKeyRef");
    const r = runner();
    expect(r).toContain("RECONCILE_MAX_RANGE = 1000");
  });

  it("remembers ALL bootstrapped keys (Set), not just the current one", () => {
    const h = hook();
    expect(h).toContain("useRef<Set<string>>(new Set())");
    expect(h).toContain("bootstrappedKeyRef.current.has(bootstrapKey)");
    expect(h).toContain("bootstrappedKeyRef.current.add(bootstrapKey)");
  });

  it("keys the bootstrap by the stable account id + physical folder + canonical", () => {
    const h = hook();
    expect(h).toContain("`${session?.account.id ?? token}|${folderPath}|${canonical}`");
  });

  it("does not prompt-reconcile Inbox/Sent", () => {
    const m = mail();
    expect(m).not.toContain('folder === "inbox" || folder === "sent"');
    expect(m).toContain('folder !== "starred"');
  });

  it("onSynced never drives a global /api/folders sweep", () => {
    const m = mail();
    const start = m.indexOf("onSynced: () => {");
    const end = m.indexOf("});", start);
    const block = m.slice(start, end);
    expect(block).toContain("loadMessages()");
    expect(block).toContain("loadCountsFast()");
    expect(block).not.toContain("await getCounts(");
  });

  it("has no hardcoded Gmail UIDVALIDITY values", () => {
    const r = runner();
    expect(r).not.toMatch(/uidvalidity\s*===?\s*\d{4,}/i);
  });
});
