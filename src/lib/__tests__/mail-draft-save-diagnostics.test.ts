import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const bridgeIndex = () =>
  readFileSync(new URL("../../../bridge/src/index.ts", import.meta.url), "utf8");
const bridgeDrafts = () =>
  readFileSync(new URL("../../../bridge/src/drafts.ts", import.meta.url), "utf8");
const diagnosticsModule = () =>
  readFileSync(new URL("../mail-draft-save-diagnostics.ts", import.meta.url), "utf8");

const FORBIDDEN = [
  "subject",
  "body",
  "recipient",
  "email",
  "draftId",
  "uid",
  "uidValidity",
  "filename",
  "messageId",
  "password",
];

describe("Draft save-trigger diagnostics PII safety", () => {
  it("client diagnostic contract contains only allowed trigger fields", () => {
    const src = diagnosticsModule();
    const contract = src.slice(src.indexOf("export interface DraftSaveTriggerDiagnostics"));
    expect(contract).toContain("reason");
    expect(contract).toContain("generation");
    expect(contract).toContain("inFlight");
    expect(contract).toContain("coalesced");
    expect(contract).toContain("dirty");
    expect(contract).toContain("attachmentsChanged");
    for (const token of FORBIDDEN) {
      expect(contract.toLowerCase()).not.toContain(token);
    }
  });

  it("Bridge trigger log carries no identity or content fields", () => {
    const src = bridgeIndex();
    const log = src.slice(src.indexOf("[draft-trigger]"), src.indexOf("const payload = DraftSavePayloadSchema.parse"));
    for (const token of FORBIDDEN) {
      expect(log.toLowerCase()).not.toContain(token);
    }
    expect(log).toContain("reason=");
    expect(log).toContain("generation=");
    expect(log).toContain("inFlight=");
    expect(log).toContain("coalesced=");
    expect(log).toContain("dirty=");
    expect(log).toContain("attachmentsChanged=");
  });

  it("Bridge diagnostics schema is strict and allowlists only the six fields", () => {
    const src = bridgeDrafts();
    const block = src.slice(
      src.indexOf("export const DraftTriggerDiagnosticsSchema"),
      src.indexOf("export type DraftTriggerDiagnostics"),
    );
    expect(block).toContain(".strict()");
    for (const token of FORBIDDEN) {
      expect(block.toLowerCase()).not.toContain(token);
    }
  });
});
