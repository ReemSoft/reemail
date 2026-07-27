// BLOCKER_C — trash origin tracker v3 unit tests.
import { describe, it, expect, beforeEach } from "vitest";
import {
  rememberFinalOrigin,
  rememberPendingOrigin,
  promotePendingOriginToFinal,
  promoteUniquePendingOriginForTrashMessage,
  buildOriginFingerprint,
  getOrigin,
  forgetFinalOrigin,
  forgetPendingOrigin,
  forgetOriginsForMessageId,
  clearAccountOrigins,
  purgeStaleTrashUidValidity,
  __finalStorageKey,
  __pendingStorageKey,
  type OriginStorage,
} from "@/lib/mail-origin-tracker";

function makeStorage(): OriginStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
}

const A = "acc-A";
const B = "acc-B";

describe("mail-origin-tracker v3 — trash identity", () => {
  let s: ReturnType<typeof makeStorage>;
  beforeEach(() => {
    s = makeStorage();
  });

  it("final remember + get round-trip keyed by (trashUV, trashUid)", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 1000, trashUid: 42 },
      { originalCanonical: "archive", originalPath: "Archive", messageId: "<x@y>" },
    );
    const hit = getOrigin(s, { accountId: A, trashUidValidity: 1000, trashUid: 42 });
    expect(hit?.originalCanonical).toBe("archive");
    expect(hit?.originalPath).toBe("Archive");
    expect(hit?.messageId).toBe("<x@y>");
  });

  it("missing entry returns null (caller uses safe fallback)", () => {
    expect(getOrigin(s, { accountId: A, trashUidValidity: 1, trashUid: 1 })).toBeNull();
  });

  it("rejects writing 'trash' as origin (nonsensical target)", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 1, trashUid: 1 },
      { originalCanonical: "trash" },
    );
    expect(s.store.size).toBe(0);
  });

  it("two accounts with the same (trashUV, trashUid) do NOT collide", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 10, trashUid: 5 },
      { originalCanonical: "archive" },
    );
    rememberFinalOrigin(
      s,
      { accountId: B, trashUidValidity: 10, trashUid: 5 },
      { originalCanonical: "spam" },
    );
    expect(getOrigin(s, { accountId: A, trashUidValidity: 10, trashUid: 5 })?.originalCanonical).toBe("archive");
    expect(getOrigin(s, { accountId: B, trashUidValidity: 10, trashUid: 5 })?.originalCanonical).toBe("spam");
  });

  it("two Trash entries in one account, same messageId, different UIDs, keep separate origins", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 100, trashUid: 1 },
      { originalCanonical: "inbox", messageId: "<same@id>" },
    );
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 100, trashUid: 2 },
      { originalCanonical: "archive", messageId: "<same@id>" },
    );
    expect(getOrigin(s, { accountId: A, trashUidValidity: 100, trashUid: 1 })?.originalCanonical).toBe("inbox");
    expect(getOrigin(s, { accountId: A, trashUidValidity: 100, trashUid: 2 })?.originalCanonical).toBe("archive");
  });

  it("missing messageId still works", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 5, trashUid: 9 },
      { originalCanonical: "inbox" },
    );
    const hit = getOrigin(s, { accountId: A, trashUidValidity: 5, trashUid: 9 });
    expect(hit?.messageId).toBeNull();
    expect(hit?.originalCanonical).toBe("inbox");
  });

  it("same UID but different trashUidValidity does NOT match (UIDVALIDITY reset)", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 100, trashUid: 42 },
      { originalCanonical: "archive" },
    );
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 200, trashUid: 42 }),
    ).toBeNull();
  });

  it("purgeStaleTrashUidValidity drops entries whose UV != current", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 100, trashUid: 1 },
      { originalCanonical: "inbox" },
    );
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 200, trashUid: 2 },
      { originalCanonical: "archive" },
    );
    const removed = purgeStaleTrashUidValidity(s, A, 200);
    expect(removed).toBe(1);
    expect(getOrigin(s, { accountId: A, trashUidValidity: 100, trashUid: 1 })).toBeNull();
    expect(getOrigin(s, { accountId: A, trashUidValidity: 200, trashUid: 2 })?.originalCanonical).toBe(
      "archive",
    );
  });

  it("forget only touches the given (account, trashUV, trashUid)", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 1, trashUid: 1 },
      { originalCanonical: "archive" },
    );
    rememberFinalOrigin(
      s,
      { accountId: B, trashUidValidity: 1, trashUid: 1 },
      { originalCanonical: "spam" },
    );
    forgetFinalOrigin(s, { accountId: A, trashUidValidity: 1, trashUid: 1 });
    expect(getOrigin(s, { accountId: A, trashUidValidity: 1, trashUid: 1 })).toBeNull();
    expect(getOrigin(s, { accountId: B, trashUidValidity: 1, trashUid: 1 })?.originalCanonical).toBe(
      "spam",
    );
  });

  it("clearAccountOrigins wipes both final + pending for that account only", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 1, trashUid: 1 },
      { originalCanonical: "archive" },
    );
    rememberPendingOrigin(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 3 },
      { originalCanonical: "inbox", createdAt: 1 },
    );
    rememberFinalOrigin(
      s,
      { accountId: B, trashUidValidity: 1, trashUid: 1 },
      { originalCanonical: "archive" },
    );
    clearAccountOrigins(s, A);
    expect(s.store.has(__finalStorageKey(A))).toBe(false);
    expect(s.store.has(__pendingStorageKey(A))).toBe(false);
    expect(s.store.has(__finalStorageKey(B))).toBe(true);
  });

  it("legacy v2 unscoped key is ignored (never surfaces)", () => {
    s.setItem("mailmaestro:trash-origin", JSON.stringify({ "thr-1": "archive" }));
    s.setItem("mailmaestro:trash-origin:v2:acc-A", JSON.stringify({ "thr-1": "archive" }));
    expect(getOrigin(s, { accountId: A, trashUidValidity: 1, trashUid: 1 })).toBeNull();
  });

  it("survives corrupted JSON without throwing", () => {
    s.setItem(__finalStorageKey(A), "{not json");
    expect(getOrigin(s, { accountId: A, trashUidValidity: 1, trashUid: 1 })).toBeNull();
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 1, trashUid: 1 },
      { originalCanonical: "archive" },
    );
    expect(getOrigin(s, { accountId: A, trashUidValidity: 1, trashUid: 1 })?.originalCanonical).toBe(
      "archive",
    );
  });

  it("ignores calls with no accountId", () => {
    rememberFinalOrigin(
      s,
      { accountId: "", trashUidValidity: 1, trashUid: 1 },
      { originalCanonical: "archive" },
    );
    expect(s.store.size).toBe(0);
  });
});

describe("mail-origin-tracker v3 — pending origins", () => {
  let s: ReturnType<typeof makeStorage>;
  beforeEach(() => {
    s = makeStorage();
  });

  it("rememberPending + promote → final entry keyed by trash identity", () => {
    rememberPendingOrigin(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 10, sourceUidValidity: 5 },
      { originalCanonical: "inbox", messageId: "<m1>", createdAt: 100 },
    );
    const promoted = promotePendingOriginToFinal(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 10, sourceUidValidity: 5 },
      { trashUidValidity: 999, trashUid: 42 },
    );
    expect(promoted?.originalCanonical).toBe("inbox");
    // Pending should be cleared:
    const pendingRaw = s.store.get(__pendingStorageKey(A));
    expect(pendingRaw).toBe("{}");
    // Final should be present:
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 999, trashUid: 42 })?.originalCanonical,
    ).toBe("inbox");
  });

  it("promote is a no-op when pending entry is absent", () => {
    const promoted = promotePendingOriginToFinal(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 10 },
      { trashUidValidity: 1, trashUid: 1 },
    );
    expect(promoted).toBeNull();
    expect(s.store.size).toBe(0);
  });

  it("forgetOriginsForMessageId wipes both pending + final entries by messageId", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 10, trashUid: 1 },
      { originalCanonical: "archive", messageId: "<mid>" },
    );
    rememberPendingOrigin(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 7 },
      { originalCanonical: "inbox", messageId: "<mid>", createdAt: 1 },
    );
    // Unrelated entry stays.
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 10, trashUid: 2 },
      { originalCanonical: "spam", messageId: "<other>" },
    );
    const removed = forgetOriginsForMessageId(s, A, "<mid>");
    expect(removed).toBe(2);
    expect(getOrigin(s, { accountId: A, trashUidValidity: 10, trashUid: 1 })).toBeNull();
    expect(getOrigin(s, { accountId: A, trashUidValidity: 10, trashUid: 2 })?.originalCanonical).toBe(
      "spam",
    );
  });

  it("forgetPendingOrigin does not touch final", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 1, trashUid: 1 },
      { originalCanonical: "archive" },
    );
    rememberPendingOrigin(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 5 },
      { originalCanonical: "inbox", createdAt: 1 },
    );
    forgetPendingOrigin(s, { accountId: A, sourceCanonical: "inbox", sourceUid: 5 });
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 1, trashUid: 1 })?.originalCanonical,
    ).toBe("archive");
  });
});

describe("mail-origin-tracker v3 — fingerprint + unique promotion", () => {
  let s: ReturnType<typeof makeStorage>;
  beforeEach(() => {
    s = makeStorage();
  });

  const fp = (extra: Partial<Parameters<typeof buildOriginFingerprint>[0]> = {}) =>
    buildOriginFingerprint({
      messageId: "<m@x>",
      fromEmail: "a@b.com",
      subject: "Hello",
      date: "2026-07-27T00:00:00Z",
      ...extra,
    });

  it("buildOriginFingerprint requires ≥2 non-empty fields (single field returns '')", () => {
    expect(buildOriginFingerprint({ messageId: "<m>" })).toBe("");
    expect(buildOriginFingerprint({ messageId: "<m>", subject: "s" })).not.toBe("");
  });

  it("fingerprints normalize case + trim so trash-side row still matches", () => {
    const a = buildOriginFingerprint({
      messageId: "<M@X>",
      fromEmail: "  A@B.com ",
      subject: "  Hello  ",
      date: "d",
    });
    const b = buildOriginFingerprint({
      messageId: "<m@x>",
      fromEmail: "a@b.com",
      subject: "hello",
      date: "d",
    });
    expect(a).toBe(b);
  });

  it("promote-unique promotes the ONLY matching pending entry", () => {
    rememberPendingOrigin(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 10 },
      { originalCanonical: "inbox", messageId: "<m@x>", fingerprint: fp(), createdAt: 1 },
    );
    rememberPendingOrigin(
      s,
      { accountId: A, sourceCanonical: "archive", sourceUid: 11 },
      {
        originalCanonical: "archive",
        messageId: "<other@x>",
        fingerprint: fp({ messageId: "<other@x>" }),
        createdAt: 1,
      },
    );
    const promoted = promoteUniquePendingOriginForTrashMessage(s, {
      accountId: A,
      trashUidValidity: 500,
      trashUid: 77,
      fingerprint: fp(),
    });
    expect(promoted?.originalCanonical).toBe("inbox");
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 500, trashUid: 77 })?.originalCanonical,
    ).toBe("inbox");
    const raw = JSON.parse(s.store.get(__pendingStorageKey(A))!) as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(1);
  });

  it("ambiguous fingerprint (≥2 matches) does NOT promote and does NOT delete", () => {
    rememberPendingOrigin(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 10 },
      { originalCanonical: "inbox", fingerprint: fp(), createdAt: 1 },
    );
    rememberPendingOrigin(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 11 },
      { originalCanonical: "inbox", fingerprint: fp(), createdAt: 1 },
    );
    const promoted = promoteUniquePendingOriginForTrashMessage(s, {
      accountId: A,
      trashUidValidity: 1,
      trashUid: 1,
      fingerprint: fp(),
    });
    expect(promoted).toBeNull();
    expect(getOrigin(s, { accountId: A, trashUidValidity: 1, trashUid: 1 })).toBeNull();
    const raw = JSON.parse(s.store.get(__pendingStorageKey(A))!) as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(2);
  });

  it("no matches → no changes", () => {
    rememberPendingOrigin(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 10 },
      { originalCanonical: "inbox", fingerprint: fp(), createdAt: 1 },
    );
    const promoted = promoteUniquePendingOriginForTrashMessage(s, {
      accountId: A,
      trashUidValidity: 1,
      trashUid: 1,
      fingerprint: fp({ subject: "different" }),
    });
    expect(promoted).toBeNull();
    const raw = JSON.parse(s.store.get(__pendingStorageKey(A))!) as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(1);
  });

  it("empty fingerprint is a no-op (never falls back to messageId only)", () => {
    rememberPendingOrigin(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 10 },
      { originalCanonical: "inbox", messageId: "<m@x>", fingerprint: "", createdAt: 1 },
    );
    const promoted = promoteUniquePendingOriginForTrashMessage(s, {
      accountId: A,
      trashUidValidity: 1,
      trashUid: 1,
      fingerprint: "",
    });
    expect(promoted).toBeNull();
  });

  it("promote is skipped when a FINAL entry already exists for the trash identity", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 1, trashUid: 1 },
      { originalCanonical: "archive" },
    );
    rememberPendingOrigin(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 10 },
      { originalCanonical: "inbox", fingerprint: fp(), createdAt: 1 },
    );
    const promoted = promoteUniquePendingOriginForTrashMessage(s, {
      accountId: A,
      trashUidValidity: 1,
      trashUid: 1,
      fingerprint: fp(),
    });
    expect(promoted).toBeNull();
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 1, trashUid: 1 })?.originalCanonical,
    ).toBe("archive");
    const raw = JSON.parse(s.store.get(__pendingStorageKey(A))!) as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(1);
  });

  it("two trash rows sharing a Message-ID keep independent origins (no cross-delete)", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 100, trashUid: 1 },
      { originalCanonical: "inbox", messageId: "<same@id>" },
    );
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 100, trashUid: 2 },
      { originalCanonical: "archive", messageId: "<same@id>" },
    );
    forgetFinalOrigin(s, { accountId: A, trashUidValidity: 100, trashUid: 1 });
    expect(getOrigin(s, { accountId: A, trashUidValidity: 100, trashUid: 1 })).toBeNull();
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 100, trashUid: 2 })?.originalCanonical,
    ).toBe("archive");
  });
});

