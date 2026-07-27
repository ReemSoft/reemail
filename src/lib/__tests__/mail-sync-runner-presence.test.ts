// Direct unit test for the reconcile 1-UID presence derivation used by
// `runMailSyncCore`. The pure helper is what `indexMoveMessage` relies on
// to distinguish "still-present" vs "confirmed-absent" — proof that the
// signal comes from the Bridge/IMAP `states` array, NOT the Local Index.
import { describe, it, expect } from "vitest";
import { derivePresenceForSingleUidReconcile } from "@/lib/mail-sync-runner.server";

describe("derivePresenceForSingleUidReconcile", () => {
  it("range with more than 1 UID → undefined (contract: only 1-UID reconcile)", () => {
    expect(derivePresenceForSingleUidReconcile(10, 20, [{ uid: 15 }])).toBeUndefined();
  });

  it("UID present in Bridge states → present:true", () => {
    expect(derivePresenceForSingleUidReconcile(42, 42, [{ uid: 42 }])).toEqual({
      uid: 42,
      present: true,
    });
  });

  it("UID missing from Bridge states → present:false (confirmed-absent)", () => {
    expect(derivePresenceForSingleUidReconcile(42, 42, [])).toEqual({
      uid: 42,
      present: false,
    });
    expect(derivePresenceForSingleUidReconcile(42, 42, [{ uid: 41 }, { uid: 43 }])).toEqual({
      uid: 42,
      present: false,
    });
  });
});
