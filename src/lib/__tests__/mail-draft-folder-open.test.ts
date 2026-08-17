// Zero-latency Draft folder open — regression contracts.
//
// Drafts V4 renders from the Bridge Draft list on the critical path because the
// Local Index can expose a stale physical UID. These contracts lock that:
//   * the cold initial Draft sync is gated by ACTUAL first-list completion
//     (draftListSettled), NOT a time-based heuristic,
//   * a post-Draft-save close never runs a global /api/folders count sweep,
//   * an index hit renders without any Bridge fallback.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shouldUseLocalIndexForFolder } from "../mail-draft-open-orchestration";

const mail = () => readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");
const hook = () => readFileSync(new URL("../../hooks/use-mail-index-sync.ts", import.meta.url), "utf8");

describe("Draft folder zero-latency open (deterministic gate)", () => {
  it("Drafts bypass Local Index while Inbox/Sent/Starred behavior stays unchanged", () => {
    expect(
      shouldUseLocalIndexForFolder({
        folder: "drafts",
        sort: "date-desc",
        mailIndexEnabled: true,
        hasMailSessionToken: true,
      }),
    ).toBe(false);
    expect(
      shouldUseLocalIndexForFolder({
        folder: "inbox",
        sort: "date-desc",
        mailIndexEnabled: true,
        hasMailSessionToken: true,
      }),
    ).toBe(true);
    expect(
      shouldUseLocalIndexForFolder({
        folder: "sent",
        sort: "date-desc",
        mailIndexEnabled: true,
        hasMailSessionToken: true,
      }),
    ).toBe(true);
    expect(
      shouldUseLocalIndexForFolder({
        folder: "starred",
        sort: "date-desc",
        mailIndexEnabled: true,
        hasMailSessionToken: true,
      }),
    ).toBe(false);
    expect(
      shouldUseLocalIndexForFolder({
        folder: "drafts",
        sort: "date-desc",
        mailIndexEnabled: false,
        hasMailSessionToken: true,
      }),
    ).toBe(false);
    expect(
      shouldUseLocalIndexForFolder({
        folder: "inbox",
        sort: "date-asc",
        mailIndexEnabled: true,
        hasMailSessionToken: true,
      }),
    ).toBe(false);
  });

  it("has NO time-based heuristic (no initialDeferMs / 2000ms)", () => {
    const h = hook();
    expect(h).not.toContain("initialDeferMs");
    expect(h).not.toContain("initialDeferTimer");
    const m = mail();
    expect(m).not.toContain("initialDeferMs");
    expect(m).not.toContain('? 2000 : undefined');
  });

  it("gates Draft initial sync on the visible list having settled", () => {
    const m = mail();
    expect(m).toContain("const [draftListSettled, setDraftListSettled] = useState(false)");
    expect(m).toContain("(folder !== \"drafts\" || draftListSettled)");
    // Reset on folder/account change so a new Drafts entry starts un-settled.
    expect(m).toContain("setDraftListSettled(false)");
  });

  it("marks the list settled on index hit, bridge success, and bridge failure", () => {
    const m = mail();
    // Exactly three settle points: index hit, bridge success, bridge failure.
    const count = m.split("setDraftListSettled(true)").length - 1;
    expect(count).toBe(3);
    // index-hit branch (between the index-hit condition and its early return)
    const idx = m.indexOf("if (res.ok && res.indexed)");
    const idxReturn = m.indexOf("return;", idx);
    expect(m.slice(idx, idxReturn)).toContain("setDraftListSettled(true)");
  });

  it("post-Draft-save close does NOT run a global count sweep", () => {
    const src = mail();
    const idx = src.indexOf("refreshAfterComposerClose: async");
    const fn = src.slice(idx, idx + 500);
    expect(fn).not.toContain("await loadCounts()");
    expect(fn).toContain('if (folder === "drafts") await loadMessages()');
  });

  it("index hit renders from the Local Index and returns before any Bridge fallback", () => {
    const src = mail();
    const start = src.indexOf("if (canUseIndex(folder, sort))");
    const end = src.indexOf("await loadFromBridge(reqId, requestScope)");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const indexBranch = src.slice(start, end);
    expect(indexBranch).toContain("if (res.ok && res.indexed)");
    expect(indexBranch).toContain('setSource("index")');
    const hit = indexBranch.indexOf("if (res.ok && res.indexed)");
    const ret = indexBranch.indexOf("return;", hit);
    expect(ret).toBeGreaterThan(hit);
  });
});
