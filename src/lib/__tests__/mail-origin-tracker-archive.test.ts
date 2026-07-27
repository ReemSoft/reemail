// Archive-kind isolation tests for the origin tracker.
//
// Guarantees:
//   * kind="archive" writes/reads a DIFFERENT storage namespace than the
//     default kind="trash", so the same (accountId, uidValidity, uid)
//     destination identity in Trash and Archive can never collide.
//   * Every mutating helper (remember, promote, forget, purge, clear) is
//     kind-aware and does not touch the sibling namespace.
//   * Restore-time lookups only surface the correct kind's origin.
import { describe, it, expect, beforeEach } from "vitest";
import {
  rememberFinalOrigin,
  rememberPendingOrigin,
  promotePendingOriginToFinal,
  promoteUniquePendingOriginForTrashMessage,
  buildOriginFingerprint,
  getOrigin,
  forgetFinalOrigin,
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

describe("mail-origin-tracker — kind='archive' namespace isolation", () => {
  let s: ReturnType<typeof makeStorage>;
  beforeEach(() => {
    s = makeStorage();
  });

  it("archive final entries land under a DIFFERENT storage key than trash", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 100, trashUid: 5 },
      { originalCanonical: "inbox", originalPath: "INBOX", messageId: "<m1@x>" },
      "archive",
    );
    expect(s.store.has(__finalStorageKey(A, "archive"))).toBe(true);
    expect(s.store.has(__finalStorageKey(A, "trash"))).toBe(false);
  });

  it("same (uv, uid) pair in trash and archive do NOT collide", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 100, trashUid: 5 },
      { originalCanonical: "inbox" },
      "trash",
    );
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 100, trashUid: 5 },
      { originalCanonical: "spam" },
      "archive",
    );
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 100, trashUid: 5 }, "trash")
        ?.originalCanonical,
    ).toBe("inbox");
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 100, trashUid: 5 }, "archive")
        ?.originalCanonical,
    ).toBe("spam");
  });

  it("archive lookup with kind='trash' returns null (and vice versa)", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 200, trashUid: 9 },
      { originalCanonical: "inbox" },
      "archive",
    );
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 200, trashUid: 9 }, "trash"),
    ).toBeNull();
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 200, trashUid: 9 }, "archive")
        ?.originalCanonical,
    ).toBe("inbox");
  });

  it("rejects originalCanonical === 'archive' when kind='archive' (nonsensical)", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 1, trashUid: 1 },
      { originalCanonical: "archive" },
      "archive",
    );
    expect(s.store.has(__finalStorageKey(A, "archive"))).toBe(false);
  });

  it("pending -> final promotion is kind-scoped (pending in archive stays put for trash)", () => {
    rememberPendingOrigin(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 42, sourceUidValidity: 10 },
      { originalCanonical: "inbox", createdAt: 1 },
      "archive",
    );
    // Try to promote in the WRONG kind — must not find anything.
    const wrong = promotePendingOriginToFinal(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 42, sourceUidValidity: 10 },
      { trashUidValidity: 300, trashUid: 7 },
      "trash",
    );
    expect(wrong).toBeNull();
    // The pending entry MUST still exist under archive.
    expect(s.store.has(__pendingStorageKey(A, "archive"))).toBe(true);
    // Correct kind promotes and clears pending.
    const right = promotePendingOriginToFinal(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 42, sourceUidValidity: 10 },
      { trashUidValidity: 300, trashUid: 7 },
      "archive",
    );
    expect(right?.originalCanonical).toBe("inbox");
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 300, trashUid: 7 }, "archive")
        ?.originalCanonical,
    ).toBe("inbox");
  });

  it("forget by messageId only removes matches in the requested kind", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 1, trashUid: 1 },
      { originalCanonical: "inbox", messageId: "<same@x>" },
      "trash",
    );
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 2, trashUid: 2 },
      { originalCanonical: "inbox", messageId: "<same@x>" },
      "archive",
    );
    const removed = forgetOriginsForMessageId(s, A, "<same@x>", "archive");
    expect(removed).toBe(1);
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 1, trashUid: 1 }, "trash"),
    ).not.toBeNull();
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 2, trashUid: 2 }, "archive"),
    ).toBeNull();
  });

  it("forgetFinalOrigin in one kind leaves the other kind intact", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 50, trashUid: 3 },
      { originalCanonical: "inbox" },
      "trash",
    );
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 50, trashUid: 3 },
      { originalCanonical: "spam" },
      "archive",
    );
    forgetFinalOrigin(s, { accountId: A, trashUidValidity: 50, trashUid: 3 }, "trash");
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 50, trashUid: 3 }, "trash"),
    ).toBeNull();
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 50, trashUid: 3 }, "archive")
        ?.originalCanonical,
    ).toBe("spam");
  });

  it("purgeStaleTrashUidValidity('archive') does not touch trash entries", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 100, trashUid: 1 },
      { originalCanonical: "inbox" },
      "trash",
    );
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 200, trashUid: 1 },
      { originalCanonical: "inbox" },
      "archive",
    );
    // Purge archive because its UIDVALIDITY changed.
    const purged = purgeStaleTrashUidValidity(s, A, 999, "archive");
    expect(purged).toBe(1);
    // Trash entry is untouched.
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 100, trashUid: 1 }, "trash"),
    ).not.toBeNull();
    expect(
      getOrigin(s, { accountId: A, trashUidValidity: 200, trashUid: 1 }, "archive"),
    ).toBeNull();
  });

  it("clearAccountOrigins wipes BOTH trash and archive namespaces", () => {
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 1, trashUid: 1 },
      { originalCanonical: "inbox" },
      "trash",
    );
    rememberFinalOrigin(
      s,
      { accountId: A, trashUidValidity: 1, trashUid: 1 },
      { originalCanonical: "inbox" },
      "archive",
    );
    clearAccountOrigins(s, A);
    expect(s.store.has(__finalStorageKey(A, "trash"))).toBe(false);
    expect(s.store.has(__finalStorageKey(A, "archive"))).toBe(false);
    expect(s.store.has(__pendingStorageKey(A, "trash"))).toBe(false);
    expect(s.store.has(__pendingStorageKey(A, "archive"))).toBe(false);
  });

  it("promoteUniquePendingOriginForTrashMessage is kind-scoped", () => {
    const fp = buildOriginFingerprint({
      messageId: "<u@x>",
      fromEmail: "a@b.co",
      subject: "hi",
    });
    rememberPendingOrigin(
      s,
      { accountId: A, sourceCanonical: "inbox", sourceUid: 1, sourceUidValidity: 5 },
      { originalCanonical: "inbox", fingerprint: fp, createdAt: 1 },
      "archive",
    );
    // Wrong kind → no promotion.
    expect(
      promoteUniquePendingOriginForTrashMessage(
        s,
        { accountId: A, trashUidValidity: 77, trashUid: 88, fingerprint: fp },
        "trash",
      ),
    ).toBeNull();
    // Right kind → promotes.
    const promoted = promoteUniquePendingOriginForTrashMessage(
      s,
      { accountId: A, trashUidValidity: 77, trashUid: 88, fingerprint: fp },
      "archive",
    );
    expect(promoted?.originalCanonical).toBe("inbox");
  });
});
