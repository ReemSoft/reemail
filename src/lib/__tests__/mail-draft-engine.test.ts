import { describe, expect, it } from "vitest";
import { DraftEngine } from "../mail-draft-engine";

describe("DraftEngine hydration barrier", () => {
  it("stays HYDRATING until every dependency settles", () => {
    const engine = new DraftEngine();
    engine.registerHydrationDependency("body");
    engine.registerHydrationDependency("inline");
    engine.settleHydrationDependency("body");
    engine.completeHydrationWhenReady();
    expect(engine.state).toBe("HYDRATING");
    engine.settleHydrationDependency("inline");
    engine.completeHydrationWhenReady();
    expect(engine.state).toBe("CLEAN");
  });

  it("hydration cannot increment generation", () => {
    const engine = new DraftEngine();
    engine.registerHydrationDependency("x");
    engine.settleHydrationDependency("x");
    engine.completeHydrationWhenReady();
    expect(engine.userGeneration).toBe(0);
    expect(engine.isDirty).toBe(false);
  });

  it("a failed hydration task still settles the barrier safely", () => {
    const engine = new DraftEngine();
    engine.registerHydrationDependency("fail-safe");
    engine.settleHydrationDependency("fail-safe");
    engine.completeHydrationWhenReady();
    expect(engine.state).toBe("CLEAN");
    expect(engine.userGeneration).toBe(0);
  });
});

describe("DraftEngine user edits", () => {
  it("only markUserEdit increments generation", () => {
    const engine = new DraftEngine();
    engine.completeHydrationWhenReady();
    engine.markUserEdit();
    expect(engine.userGeneration).toBe(1);
    expect(engine.isDirty).toBe(true);
    expect(engine.state).toBe("DIRTY");
  });

  it("markSaved clears dirty only for the committed generation", () => {
    const engine = new DraftEngine();
    engine.completeHydrationWhenReady();
    engine.markUserEdit();
    engine.markSaved(1);
    expect(engine.savedGeneration).toBe(1);
    expect(engine.isDirty).toBe(false);
    expect(engine.state).toBe("CLEAN");
  });

  it("a newer edit remains dirty after an older save", () => {
    const engine = new DraftEngine();
    engine.completeHydrationWhenReady();
    engine.markUserEdit();
    engine.markUserEdit();
    engine.markSaved(1);
    expect(engine.userGeneration).toBe(2);
    expect(engine.isDirty).toBe(true);
    expect(engine.state).toBe("DIRTY");
  });
});

describe("DraftEngine attachment dependencies", () => {
  it("blocks save while a required upload dependency is pending", () => {
    const engine = new DraftEngine();
    engine.completeHydrationWhenReady();
    engine.markUserEdit();
    engine.registerAttachmentDependency(1, "file-a");
    expect(engine.hasPendingDependencies()).toBe(true);
    expect(engine.beginSave()).toBe(false);
    expect(engine.state).toBe("UPLOADING");
  });

  it("resolving dependency enables exactly one eligible save", () => {
    const engine = new DraftEngine();
    engine.completeHydrationWhenReady();
    engine.markUserEdit();
    engine.registerAttachmentDependency(1, "file-a");
    engine.resolveAttachmentDependency(1, "file-a");
    expect(engine.userGeneration).toBe(1);
    expect(engine.state).toBe("READY_TO_SAVE");
    expect(engine.beginSave()).toBe(true);
    expect(engine.state).toBe("SAVING");
  });

  it("ready event never increments generation", () => {
    const engine = new DraftEngine();
    engine.completeHydrationWhenReady();
    engine.markUserEdit();
    const before = engine.userGeneration;
    engine.registerAttachmentDependency(before, "file-a");
    engine.resolveAttachmentDependency(before, "file-a");
    expect(engine.userGeneration).toBe(before);
  });

  it("keeps save blocked until every new attachment resolves", () => {
    const engine = new DraftEngine();
    engine.completeHydrationWhenReady();
    engine.markUserEdit();
    engine.registerAttachmentDependency(1, "file-a");
    engine.registerAttachmentDependency(1, "file-b");
    engine.resolveAttachmentDependency(1, "file-a");
    expect(engine.beginSave()).toBe(false);
    engine.resolveAttachmentDependency(1, "file-b");
    expect(engine.beginSave()).toBe(true);
  });

  it("failed attachment keeps dirty and prevents incomplete commit", () => {
    const engine = new DraftEngine();
    engine.completeHydrationWhenReady();
    engine.markUserEdit();
    engine.registerAttachmentDependency(1, "file-a");
    engine.failAttachmentDependency(1, "file-a");
    expect(engine.beginSave()).toBe(false);
    expect(engine.isDirty).toBe(true);
    expect(engine.state).toBe("FAILED");
  });
});

describe("DraftEngine delete", () => {
  it("delete owns lifecycle and blocks new saves", () => {
    const engine = new DraftEngine();
    engine.completeHydrationWhenReady();
    engine.markUserEdit();
    engine.beginDelete();
    expect(engine.state).toBe("DELETING");
    expect(engine.beginSave()).toBe(false);
  });

  it("failed delete returns to dirty/clean without losing generation state", () => {
    const engine = new DraftEngine();
    engine.completeHydrationWhenReady();
    engine.markUserEdit();
    engine.beginDelete();
    engine.completeDeleteFailure();
    expect(engine.state).toBe("DIRTY");
    expect(engine.isDirty).toBe(true);
  });
});
