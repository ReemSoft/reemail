// Behavioral tests for the Blocker 2 targeted-sync orchestration core.
//
// Contracts locked:
//   * Bridge `/api/move` is called EXACTLY once per orchestration.
//   * Full-mapping path skips destination sync entirely (calls=0) and
//     surfaces the Bridge-provided destination UID unchanged.
//   * No-mapping path runs targeted destination sync (initial when the
//     destination has no cursor, incremental otherwise) — never a full
//     account sync.
//   * `hasMore` incremental loops are bounded (MAX_TARGETED_ROUNDS).
//   * Destination UID discovery honors the pre-move cutoff, prefers
//     Message-ID, falls back to fingerprint, and NEVER returns a UID when
//     0 or >1 candidates match (no random pick, no source-UID fabrication).
//   * Source confirmation runs a 1-UID reconcile on the physical source
//     (starred → INBOX) and NEVER rolls the UI back on failure.
//   * IMAP success + local write-through/sync failure → `ok:true`,
//     `destinationReady:false`, `index:"partial"` — no false Rollback.
import { describe, it, expect } from "vitest";
import {
  moveMessageOrchestration,
  MAX_TARGETED_ROUNDS,
  type MoveOrchestrationDeps,
  type BridgeMoveOutcome,
  type WriteThroughOutcome,
  type SyncOutcome,
  type SourceReconcileOutcome,
  type SourceInfo,
  type DestInfo,
} from "@/lib/mail-move-orchestration";
import type { MessageFingerprint } from "@/lib/mail-move-writer.server";


const FP: MessageFingerprint = {
  messageId: "<abc@x>",
  internalDate: "2026-01-01T00:00:00.000Z",
  sizeBytes: 1234,
  subject: "hi",
  fromEmail: "a@x",
};

function makeSource(over: Partial<SourceInfo> = {}): SourceInfo {
  return {
    folderId: "f-src",
    uidvalidity: 100,
    path: "INBOX",
    canonical: "inbox",
    cursorNewestSyncedUid: 500,
    fingerprint: FP,
    ...over,
  };
}

interface Harness {
  deps: MoveOrchestrationDeps;
  calls: {
    bridgeMove: number;
    writeThrough: number;
    destSync: number;
    sourceReconcile: number;
    discover: number;
  };
  destSyncArgs: Array<{ mode: string; folderPath: string; canonical: string }>;
  reconcileArgs: Array<{ folderPath: string; canonical: string; uid: number }>;
}

function makeDeps(
  opts: {
    source?: SourceInfo | null;
    destBefore?: DestInfo;
    destAfter?: DestInfo;
    bridge?: BridgeMoveOutcome;
    writeThrough?: WriteThroughOutcome;
    destSync?: SyncOutcome | SyncOutcome[];
    sourceReconcile?: SourceReconcileOutcome;
    discoverPlan?: Array<{ uid: number; uidvalidity: number } | null>;
  } = {},
): Harness {

  const calls = {
    bridgeMove: 0,
    writeThrough: 0,
    destSync: 0,
    sourceReconcile: 0,
    discover: 0,
  };
  const destSyncArgs: Harness["destSyncArgs"] = [];
  const reconcileArgs: Harness["reconcileArgs"] = [];
  const syncQueue: SyncOutcome[] = Array.isArray(opts.destSync)
    ? [...opts.destSync]
    : opts.destSync
      ? [opts.destSync]
      : [{ ok: true, busy: false, hasMore: false }];
  const discoverQueue = opts.discoverPlan ?? [null];

  const deps: MoveOrchestrationDeps = {
    loadSource: async () => (opts.source === undefined ? makeSource() : opts.source),
    loadDest: async () => opts.destBefore ?? { folder: null, cursorNewestSyncedUid: null },
    bridgeMove: async () => {
      calls.bridgeMove += 1;
      return (
        opts.bridge ?? {
          ok: true,
          move: { sourceUid: 42, uidMappingAvailable: false },
        }
      );
    },
    applyWriteThrough: async () => {
      calls.writeThrough += 1;
      return (
        opts.writeThrough ?? {
          ok: true,
          applied: "source-only",
          sourceTombstoned: true,
          destinationInserted: false,
        }
      );
    },
    runDestSync: async (args) => {
      calls.destSync += 1;
      destSyncArgs.push(args);
      return syncQueue.shift() ?? { ok: true, busy: false, hasMore: false };
    },
    reloadDest: async () =>
      opts.destAfter ?? opts.destBefore ?? { folder: null, cursorNewestSyncedUid: null },
    discoverDest: async () => {
      calls.discover += 1;
      const next = discoverQueue.shift();
      return next ?? null;
    },
    runSourceReconcile: async (args) => {
      calls.sourceReconcile += 1;
      reconcileArgs.push(args);
      return opts.sourceReconcile ?? { ok: true, busy: false, targetUidPresent: false };
    },

    logError: () => {},
  };
  return { deps, calls, destSyncArgs, reconcileArgs };
}

const baseInput = {
  sourceCanonical: "inbox",
  destCanonical: "trash",
  sourceUid: 42,
} as const;

// -------------------- Mapping path --------------------

describe("full UIDPLUS mapping short-circuit", () => {
  it("skips targeted destination sync entirely", async () => {
    const h = makeDeps({
      bridge: {
        ok: true,
        move: {
          sourceUid: 42,
          destinationPath: "Trash",
          destinationUid: 981,
          destinationUidValidity: "555",
          uidMappingAvailable: true,
        },
      },
      writeThrough: {
        ok: true,
        applied: "full",
        sourceTombstoned: true,
        destinationInserted: true,
      },
    });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(h.calls.bridgeMove).toBe(1);
    expect(h.calls.destSync).toBe(0);
    expect(h.calls.discover).toBe(0);
    expect(res.destinationSync).toBe("not-needed");
    expect(res.destinationReady).toBe(true);
    expect(res.discoveredDestinationUid).toBe(981);
    expect(res.discoveredDestinationUidValidity).toBe("555");
    expect(res.index).toBe("full");
  });

  it("mapping present but writer degraded to source-only → still runs targeted sync", async () => {
    const h = makeDeps({
      destBefore: {
        folder: { id: "f-dst", uidvalidity: 200, path: "Trash" },
        cursorNewestSyncedUid: 900,
      },
      destAfter: {
        folder: { id: "f-dst", uidvalidity: 200, path: "Trash" },
        cursorNewestSyncedUid: 981,
      },
      bridge: {
        ok: true,
        move: {
          sourceUid: 42,
          destinationPath: "Trash",
          destinationUid: 981,
          destinationUidValidity: "200",
          uidMappingAvailable: true,
        },
      },
      writeThrough: {
        ok: true,
        applied: "source-only",
        sourceTombstoned: true,
        destinationInserted: false,
      },
      discoverPlan: [{ uid: 981, uidvalidity: 200 }],
    });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(h.calls.destSync).toBe(1);
    expect(res.destinationSync).toBe("incremental");
    expect(res.destinationReady).toBe(true);
    expect(res.discoveredDestinationUid).toBe(981);
  });
});

// -------------------- No-mapping path --------------------

describe("no UIDPLUS mapping — targeted destination sync", () => {
  it("destination has cursor → incremental, discovers UID above cutoff", async () => {
    const h = makeDeps({
      destBefore: {
        folder: { id: "f-dst", uidvalidity: 200, path: "Trash" },
        cursorNewestSyncedUid: 900,
      },
      destAfter: {
        folder: { id: "f-dst", uidvalidity: 200, path: "Trash" },
        cursorNewestSyncedUid: 981,
      },
      bridge: {
        ok: true,
        move: { sourceUid: 42, destinationPath: "Trash", uidMappingAvailable: false },
      },
      discoverPlan: [{ uid: 981, uidvalidity: 200 }],
    });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(h.calls.destSync).toBe(1);
    expect(h.destSyncArgs[0].mode).toBe("incremental");
    expect(res.destinationReady).toBe(true);
    expect(res.discoveredDestinationUid).toBe(981);
    expect(res.destinationSync).toBe("incremental");
  });

  it("destination has NO cursor → initial (single round, not looped)", async () => {
    const h = makeDeps({
      destBefore: { folder: null, cursorNewestSyncedUid: null },
      destAfter: {
        folder: { id: "f-dst", uidvalidity: 300, path: "Archive" },
        cursorNewestSyncedUid: 5,
      },
      bridge: {
        ok: true,
        move: { sourceUid: 42, destinationPath: "Archive", uidMappingAvailable: false },
      },
      destSync: [
        { ok: true, busy: false, hasMore: true },
        { ok: true, busy: false, hasMore: true },
      ],
      discoverPlan: [null, null],
    });
    const res = await moveMessageOrchestration(h.deps, { ...baseInput, destCanonical: "archive" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(h.destSyncArgs[0].mode).toBe("initial");
    expect(h.calls.destSync).toBe(1); // initial NEVER loops
    expect(res.destinationSync).toBe("initial");
    expect(res.destinationReady).toBe(false);
  });

  it("incremental hasMore loops but is capped at MAX_TARGETED_ROUNDS", async () => {
    const h = makeDeps({
      destBefore: {
        folder: { id: "f-dst", uidvalidity: 200, path: "Trash" },
        cursorNewestSyncedUid: 900,
      },
      destAfter: {
        folder: { id: "f-dst", uidvalidity: 200, path: "Trash" },
        cursorNewestSyncedUid: 950,
      },
      bridge: {
        ok: true,
        move: { sourceUid: 42, destinationPath: "Trash", uidMappingAvailable: false },
      },
      destSync: new Array(5).fill({ ok: true, busy: false, hasMore: true }),
      discoverPlan: [null, null, null, null, null],
    });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(h.calls.destSync).toBe(MAX_TARGETED_ROUNDS);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.destinationReady).toBe(false);
  });

  it("stops looping the moment UID is discovered", async () => {
    const h = makeDeps({
      destBefore: {
        folder: { id: "f-dst", uidvalidity: 200, path: "Trash" },
        cursorNewestSyncedUid: 900,
      },
      destAfter: {
        folder: { id: "f-dst", uidvalidity: 200, path: "Trash" },
        cursorNewestSyncedUid: 981,
      },
      bridge: {
        ok: true,
        move: { sourceUid: 42, destinationPath: "Trash", uidMappingAvailable: false },
      },
      destSync: [
        { ok: true, busy: false, hasMore: true },
        { ok: true, busy: false, hasMore: true },
      ],
      discoverPlan: [null, { uid: 981, uidvalidity: 200 }],
    });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(h.calls.destSync).toBe(2);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.destinationReady).toBe(true);
  });
});

// -------------------- Source confirmation --------------------

describe("source confirmation", () => {
  it("source cursor present → 1-UID reconcile on physical source", async () => {
    const h = makeDeps({
      source: makeSource({ cursorNewestSyncedUid: 500, path: "INBOX", canonical: "inbox" }),
    });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(h.calls.sourceReconcile).toBe(1);
    expect(h.reconcileArgs[0]).toEqual({ folderPath: "INBOX", canonical: "inbox", uid: 42 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sourceConfirmation).toBe("confirmed-absent");
  });

  it("starred source resolves to physical INBOX (never sync 'starred')", async () => {
    // Simulated by the loader — the orchestration only sees the physical values.
    const h = makeDeps({
      source: makeSource({ path: "INBOX", canonical: "inbox" }),
    });
    await moveMessageOrchestration(h.deps, { ...baseInput, sourceCanonical: "starred" });
    expect(h.reconcileArgs[0].canonical).toBe("inbox");
    expect(h.reconcileArgs[0].folderPath).toBe("INBOX");
  });

  it("no source cursor → NO reconcile, tombstone-only", async () => {
    const h = makeDeps({ source: makeSource({ cursorNewestSyncedUid: null }) });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(h.calls.sourceReconcile).toBe(0);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sourceConfirmation).toBe("tombstone-only");
  });

  it("reconcile busy → sourceConfirmation='busy', still ok:true", async () => {
    const h = makeDeps({ sourceReconcile: { ok: true, busy: true } });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sourceConfirmation).toBe("busy");
  });

  it("reconcile failed → sourceConfirmation='failed', NEVER rolls back", async () => {
    const h = makeDeps({
      sourceReconcile: { ok: false, error: "x", code: "SYNC_FAILED" },
    });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sourceConfirmation).toBe("failed");
  });
});

// -------------------- Failure semantics --------------------

describe("failure semantics", () => {
  it("bridge move fails → NO writer, NO sync, ok:false", async () => {
    const h = makeDeps({
      bridge: { ok: false, error: "boom", code: "BRIDGE_MOVE_FAILED" },
    });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(h.calls.bridgeMove).toBe(1);
    expect(h.calls.writeThrough).toBe(0);
    expect(h.calls.destSync).toBe(0);
    expect(h.calls.sourceReconcile).toBe(0);
    expect(res.ok).toBe(false);
  });

  it("IMAP ok + writer throws + fingerprint captured → still tries targeted sync, ok:true", async () => {
    const h = makeDeps({
      destBefore: {
        folder: { id: "f-dst", uidvalidity: 200, path: "Trash" },
        cursorNewestSyncedUid: 900,
      },
      destAfter: {
        folder: { id: "f-dst", uidvalidity: 200, path: "Trash" },
        cursorNewestSyncedUid: 981,
      },
      writeThrough: { ok: false, error: "boom" },
      bridge: {
        ok: true,
        move: { sourceUid: 42, destinationPath: "Trash", uidMappingAvailable: false },
      },
      discoverPlan: [{ uid: 981, uidvalidity: 200 }],
    });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.index).toBe("partial");
    expect(h.calls.destSync).toBe(1);
    expect(res.destinationReady).toBe(true);
  });

  it("IMAP ok + targeted sync fails → ok:true, index=partial, destinationReady:false", async () => {
    const h = makeDeps({
      destBefore: {
        folder: { id: "f-dst", uidvalidity: 200, path: "Trash" },
        cursorNewestSyncedUid: 900,
      },
      bridge: {
        ok: true,
        move: { sourceUid: 42, destinationPath: "Trash", uidMappingAvailable: false },
      },
      destSync: { ok: false, error: "x", code: "SYNC_FAILED" },
    });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.destinationSync).toBe("failed");
    expect(res.destinationReady).toBe(false);
    expect(res.index).toBe("partial");
  });

  it("targeted sync busy → destinationSync='busy', index=partial, no full-sync fallback", async () => {
    const h = makeDeps({
      destBefore: {
        folder: { id: "f-dst", uidvalidity: 200, path: "Trash" },
        cursorNewestSyncedUid: 900,
      },
      bridge: {
        ok: true,
        move: { sourceUid: 42, destinationPath: "Trash", uidMappingAvailable: false },
      },
      destSync: { ok: true, busy: true },
    });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(h.calls.destSync).toBe(1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.destinationSync).toBe("busy");
    expect(res.destinationReady).toBe(false);
    expect(res.index).toBe("partial");
  });

  it("no destinationPath AND no local dest folder → destinationSync='failed', index=partial", async () => {
    const h = makeDeps({
      destBefore: { folder: null, cursorNewestSyncedUid: null },
      bridge: { ok: true, move: { sourceUid: 42, uidMappingAvailable: false } },
    });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(h.calls.destSync).toBe(0);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.destinationSync).toBe("failed");
    expect(res.index).toBe("partial");
  });
});

// -------------------- No-fingerprint contract (BLOCKER_2_FIX) --------------------

describe("no source fingerprint — sync still runs, discovery is skipped", () => {
  it("no fingerprint + dest cursor → incremental sync runs, 0 discovery calls", async () => {
    const h = makeDeps({
      source: makeSource({ fingerprint: null }),
      destBefore: {
        folder: { id: "f-dst", uidvalidity: 200, path: "Trash" },
        cursorNewestSyncedUid: 900,
      },
      destAfter: {
        folder: { id: "f-dst", uidvalidity: 200, path: "Trash" },
        cursorNewestSyncedUid: 981,
      },
      bridge: {
        ok: true,
        move: { sourceUid: 42, destinationPath: "Trash", uidMappingAvailable: false },
      },
    });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(h.calls.destSync).toBe(1);
    expect(h.destSyncArgs[0].mode).toBe("incremental");
    expect(h.calls.discover).toBe(0);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.destinationSync).toBe("incremental");
    expect(res.destinationReady).toBe(false);
  });

  it("no fingerprint + no dest cursor → initial sync runs, 0 discovery calls", async () => {
    const h = makeDeps({
      source: makeSource({ fingerprint: null }),
      destBefore: { folder: null, cursorNewestSyncedUid: null },
      destAfter: {
        folder: { id: "f-dst", uidvalidity: 300, path: "Archive" },
        cursorNewestSyncedUid: 5,
      },
      bridge: {
        ok: true,
        move: { sourceUid: 42, destinationPath: "Archive", uidMappingAvailable: false },
      },
    });
    const res = await moveMessageOrchestration(h.deps, { ...baseInput, destCanonical: "archive" });
    expect(h.calls.destSync).toBe(1);
    expect(h.destSyncArgs[0].mode).toBe("initial");
    expect(h.calls.discover).toBe(0);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.destinationSync).toBe("initial");
    expect(res.destinationReady).toBe(false);
  });
});

// -------------------- Source presence contract (BLOCKER_2_FIX) --------------------

describe("source confirmation presence semantics", () => {
  it("UID absent from Bridge → confirmed-absent, index stays applied", async () => {
    const h = makeDeps({
      bridge: {
        ok: true,
        move: {
          sourceUid: 42,
          destinationPath: "Trash",
          destinationUid: 981,
          destinationUidValidity: "200",
          uidMappingAvailable: true,
        },
      },
      writeThrough: {
        ok: true,
        applied: "full",
        sourceTombstoned: true,
        destinationInserted: true,
      },
      sourceReconcile: { ok: true, busy: false, targetUidPresent: false },
    });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sourceConfirmation).toBe("confirmed-absent");
    expect(res.index).toBe("full");
  });

  it("UID still present on Bridge → still-present, index downgraded to partial", async () => {
    const h = makeDeps({
      bridge: {
        ok: true,
        move: {
          sourceUid: 42,
          destinationPath: "Trash",
          destinationUid: 981,
          destinationUidValidity: "200",
          uidMappingAvailable: true,
        },
      },
      writeThrough: {
        ok: true,
        applied: "full",
        sourceTombstoned: true,
        destinationInserted: true,
      },
      sourceReconcile: { ok: true, busy: false, targetUidPresent: true },
    });
    const res = await moveMessageOrchestration(h.deps, baseInput);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sourceConfirmation).toBe("still-present");
    expect(res.index).toBe("partial");
  });
});


// -------------------- Call-count invariants --------------------

describe("call-count invariants", () => {
  it("bridge /api/move is invoked exactly once in every ok path", async () => {
    for (const setup of [
      makeDeps({
        bridge: { ok: true, move: { sourceUid: 1, uidMappingAvailable: false } },
      }),
      makeDeps({
        bridge: {
          ok: true,
          move: {
            sourceUid: 1,
            uidMappingAvailable: true,
            destinationUid: 2,
            destinationUidValidity: "1",
            destinationPath: "T",
          },
        },
        writeThrough: {
          ok: true,
          applied: "full",
          sourceTombstoned: true,
          destinationInserted: true,
        },
      }),
    ]) {
      await moveMessageOrchestration(setup.deps, baseInput);
      expect(setup.calls.bridgeMove).toBe(1);
    }
  });

  it("full-mapping path performs zero targeted sync calls", async () => {
    const h = makeDeps({
      bridge: {
        ok: true,
        move: {
          sourceUid: 42,
          destinationPath: "Trash",
          destinationUid: 981,
          destinationUidValidity: "200",
          uidMappingAvailable: true,
        },
      },
      writeThrough: {
        ok: true,
        applied: "full",
        sourceTombstoned: true,
        destinationInserted: true,
      },
    });
    await moveMessageOrchestration(h.deps, baseInput);
    expect(h.calls.destSync).toBe(0);
    expect(h.calls.discover).toBe(0);
  });
});
