// Direct unit tests for `discoverDestinationUid` (BLOCKER_2_FIX_VERIFICATION).
//
// Contract exercised:
//   1) Message-ID above cutoff, unique → returns that row.
//   2) Message-ID only below cutoff → null (pre-existing duplicate).
//   3) Message-ID duplicated above cutoff → NO random pick, falls through
//      to fingerprint matching.
//   4) Fingerprint unique above cutoff → returned.
//   5) Fingerprint ambiguous → null.
//   6) Missing Message-ID + incomplete fingerprint → null.
//   7) `deleted_at IS NOT NULL` rows never appear in results.
//   8) Non-integer / non-positive uid/uidvalidity rejected.
import { describe, it, expect } from "vitest";
import {
  discoverDestinationUid,
  type MessageFingerprint,
} from "@/lib/mail-move-writer.server";
import type { SupabaseClient } from "@supabase/supabase-js";

interface FakeRow {
  uid: number | string;
  uidvalidity: number | string;
  message_id: string | null;
  internal_date: string | null;
  size_bytes: number | null;
  subject: string | null;
  from_addr: { email?: string } | null;
  deleted_at: string | null;
}

function makeSupabase(rows: FakeRow[]): SupabaseClient {
  const builder = () => {
    const filters: Record<string, unknown> = {};
    let gtCol: string | null = null;
    let gtVal: number | null = null;
    let isNullCol: string | null = null;
    const b: {
      select: () => typeof b;
      eq: (c: string, v: unknown) => typeof b;
      gt: (c: string, v: number) => typeof b;
      is: (c: string, v: unknown) => typeof b;
      then: (onFulfilled: (r: { data: FakeRow[]; error: null }) => unknown) => Promise<unknown>;
    } = {
      select: () => b,
      eq: (c, v) => {
        filters[c] = v;
        return b;
      },
      gt: (c, v) => {
        gtCol = c;
        gtVal = v;
        return b;
      },
      is: (c, v) => {
        if (v === null) isNullCol = c;
        return b;
      },
      then: (onFulfilled) => {
        const filtered = rows.filter((r) => {
          const rec = r as unknown as Record<string, unknown>;
          for (const [k, v] of Object.entries(filters)) {
            if (rec[k] !== v) return false;
          }
          if (gtCol && gtVal !== null) {
            const rv = Number(rec[gtCol]);
            if (!(rv > gtVal)) return false;
          }
          if (isNullCol && rec[isNullCol] != null) return false;
          return true;
        });
        return Promise.resolve(onFulfilled({ data: filtered, error: null }));
      },

    };
    return b;
  };
  return {
    from: (_t: string) => ({ select: () => builder() }),
  } as unknown as SupabaseClient;
}

const BASE = {
  accountId: "acc",
  folderId: "f",
  uidvalidity: 200,
  cutoffUid: 900,
};

const FP: MessageFingerprint = {
  messageId: "<m1@x>",
  internalDate: "2026-01-01T00:00:00.000Z",
  sizeBytes: 1234,
  subject: "hi",
  fromEmail: "a@x",
};

function row(over: Partial<FakeRow> = {}): FakeRow {
  return {
    uid: 950,
    uidvalidity: 200,
    message_id: "<m1@x>",
    internal_date: "2026-01-01T00:00:00.000Z",
    size_bytes: 1234,
    subject: "hi",
    from_addr: { email: "a@x" },
    deleted_at: null,
    ...over,
  };
}

describe("discoverDestinationUid — Message-ID branch", () => {
  it("unique Message-ID above cutoff → returns that row", async () => {
    const sb = makeSupabase([row({ uid: 950 })]);
    const hit = await discoverDestinationUid(sb, { ...BASE, fingerprint: FP });
    expect(hit).toEqual({ uid: 950, uidvalidity: 200 });
  });

  it("Message-ID only below cutoff → null", async () => {
    const sb = makeSupabase([row({ uid: 100 })]);
    const hit = await discoverDestinationUid(sb, { ...BASE, fingerprint: FP });
    expect(hit).toBeNull();
  });

  it("Message-ID duplicated above cutoff → falls back to fingerprint (ambiguous → null)", async () => {
    const sb = makeSupabase([row({ uid: 950 }), row({ uid: 951 })]);
    const hit = await discoverDestinationUid(sb, { ...BASE, fingerprint: FP });
    expect(hit).toBeNull(); // fingerprint also matches both → ambiguous
  });

  it("tombstoned rows are excluded from the Message-ID hit", async () => {
    const sb = makeSupabase([row({ uid: 950, deleted_at: "2026-01-02T00:00:00Z" })]);
    const hit = await discoverDestinationUid(sb, { ...BASE, fingerprint: FP });
    expect(hit).toBeNull();
  });
});

describe("discoverDestinationUid — fingerprint fallback", () => {
  it("no Message-ID, unique fingerprint above cutoff → returned", async () => {
    const sb = makeSupabase([row({ uid: 950, message_id: null })]);
    const hit = await discoverDestinationUid(sb, {
      ...BASE,
      fingerprint: { ...FP, messageId: null },
    });
    expect(hit).toEqual({ uid: 950, uidvalidity: 200 });
  });

  it("no Message-ID, ambiguous fingerprint → null", async () => {
    const sb = makeSupabase([
      row({ uid: 950, message_id: null }),
      row({ uid: 951, message_id: null }),
    ]);
    const hit = await discoverDestinationUid(sb, {
      ...BASE,
      fingerprint: { ...FP, messageId: null },
    });
    expect(hit).toBeNull();
  });

  it("no Message-ID + missing internal_date/size → null (insufficient identity)", async () => {
    const sb = makeSupabase([row({ uid: 950, message_id: null })]);
    const hit = await discoverDestinationUid(sb, {
      ...BASE,
      fingerprint: { messageId: null, internalDate: null, sizeBytes: null, subject: null, fromEmail: null },
    });
    expect(hit).toBeNull();
  });
});

describe("discoverDestinationUid — sanity validation", () => {
  it("rejects rows with non-positive uid/uidvalidity", async () => {
    const sb = makeSupabase([row({ uid: -5 })]);
    const hit = await discoverDestinationUid(sb, { ...BASE, cutoffUid: -100, fingerprint: FP });
    expect(hit).toBeNull();
  });

  it("rejects rows where uid parses to NaN", async () => {
    const sb = makeSupabase([row({ uid: "not-a-number" as unknown as number })]);
    const hit = await discoverDestinationUid(sb, { ...BASE, cutoffUid: 0, fingerprint: FP });
    expect(hit).toBeNull();
  });
});
