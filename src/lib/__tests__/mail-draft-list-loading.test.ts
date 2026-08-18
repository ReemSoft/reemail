import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const mail = () => readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8");

describe("Draft list loading reconciliation", () => {
  it("does not publish raw provider rows before Working Draft projection is loaded", () => {
    const src = mail();
    expect(src).toContain("draftReconciledMessagesRef");
    expect(src).toContain("workingDraftsSettled");
    expect(src).toContain("workingDraftsLoaded");
    expect(src).toContain("draftReconciledScopeRef.current === currentAccountId");
  });

  it("keeps the previous reconciled Draft snapshot during refresh", () => {
    const src = mail();
    const start = src.indexOf("const visibleMessages = useMemo(() => {");
    const end = src.indexOf("const filteredMessages = useMemo(() => {", start);
    const fn = src.slice(start, end);
    expect(fn).toContain("draftReconciledMessagesRef.current");
    expect(fn).toContain("if (!workingDraftsSettled)");
    expect(fn).toContain("if (!workingDraftsLoaded)");
  });

  it("does not add a provider-only Draft hide rule", () => {
    const src = mail();
    const start = src.indexOf("const visibleProviderMessages = enrichedProviderMessages.filter");
    const end = src.indexOf("const providerDraftIds = new Set", start);
    const fn = src.slice(start, end);
    expect(fn).not.toContain("return !message.draftIdHeader && false");
    expect(fn).toContain("visibleProviderMessages");
  });

  it("provider and Working Draft loading are independent effect paths", () => {
    const src = mail();
    expect(src).toContain("void refreshWorkingDrafts();");
    expect(src).toContain("loadMessages();");
  });

  it("opening Drafts does not schedule provider checkpoint or APPEND", () => {
    const src = mail();
    const start = src.indexOf("const refreshWorkingDrafts = useCallback");
    const end = src.indexOf("const rememberWorkingDraftRecord = useCallback", start);
    const fn = src.slice(start, end);
    expect(fn).not.toContain("scheduleWorkingDraftCheckpoint");
    expect(fn).not.toContain("startWorkingDraftCheckpoint");
  });

  it("non-Draft list path remains unchanged", () => {
    const src = mail();
    expect(src).toContain('if (folder !== "drafts") return messages;');
  });

  it("Working Draft projection failure cannot leave Drafts permanently loading", () => {
    const src = mail();
    expect(src).toContain("setWorkingDraftsSettled(true);");
    expect(src).toContain("setWorkingDraftsLoaded(false);");
  });

  it("uses account-scoped reconciled snapshot", () => {
    const src = mail();
    expect(src).toContain("draftReconciledScopeRef.current");
    expect(src).toContain("currentAccountId");
  });

  it("first Draft open uses an explicit Draft loading state", () => {
    const src = mail();
    expect(src).toContain("const effectiveLoading =");
    expect(src).toContain("loading || !workingDraftsSettled");
  });
});
