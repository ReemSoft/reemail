import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

type Folder = "inbox" | "starred" | "sent" | "drafts";
type Count = { folder: Folder; total: number; unread: number; supported?: boolean };
type CountState = Record<Folder, { total: number; unread: number; supported: boolean }>;

const initial: CountState = {
  inbox: { total: 12, unread: 3, supported: true },
  starred: { total: 0, unread: 0, supported: true },
  sent: { total: 8, unread: 0, supported: true },
  drafts: { total: 2, unread: 0, supported: true },
};

function applyExistingAuthoritativeResponse(
  prev: CountState,
  counts: Count[],
  starCountHot: boolean,
): CountState {
  const draftsCount = counts.find((count) => count.folder === "drafts");
  const starredCount = counts.find((count) => count.folder === "starred");
  const next = { ...prev };
  if (draftsCount) {
    next.drafts = {
      total: draftsCount.total,
      unread: draftsCount.unread,
      supported: draftsCount.supported !== false,
    };
  }
  if (starredCount) {
    const current = prev.starred;
    next.starred = {
      total: starCountHot ? current.total : starredCount.total,
      unread: starredCount.unread,
      supported: starredCount.supported !== false,
    };
  }
  return next;
}

describe("startup authoritative Starred count hydration", () => {
  it.each([
    { total: 0, unread: 0 },
    { total: 1, unread: 0 },
    { total: 7, unread: 2 },
  ])("restores exact starred total=$total unread=$unread", ({ total, unread }) => {
    const result = applyExistingAuthoritativeResponse(
      initial,
      [{ folder: "starred", total, unread, supported: true }],
      false,
    );
    expect(result.starred).toEqual({ total, unread, supported: true });
    expect(result.inbox).toBe(initial.inbox);
    expect(result.sent).toBe(initial.sent);
    expect(result.drafts).toBe(initial.drafts);
  });

  it("hydrates Drafts and Starred from one existing authoritative response", async () => {
    const getCounts = vi.fn().mockResolvedValue({
      ok: true,
      counts: [
        { folder: "drafts", total: 5, unread: 0, supported: true },
        { folder: "starred", total: 4, unread: 1, supported: true },
      ] satisfies Count[],
    });
    const response = await getCounts();
    const result = applyExistingAuthoritativeResponse(initial, response.counts, false);
    expect(getCounts).toHaveBeenCalledOnce();
    expect(result.drafts.total).toBe(5);
    expect(result.starred).toEqual({ total: 4, unread: 1, supported: true });
  });

  it("preserves optimistic total while hot but refreshes non-racing metadata", () => {
    const prev = { ...initial, starred: { total: 4, unread: 0, supported: true } };
    const result = applyExistingAuthoritativeResponse(
      prev,
      [{ folder: "starred", total: 3, unread: 2, supported: false }],
      true,
    );
    expect(result.starred).toEqual({ total: 4, unread: 2, supported: false });
  });

  it("accepts authoritative total when the optimistic star guard is cold", () => {
    const result = applyExistingAuthoritativeResponse(
      initial,
      [{ folder: "starred", total: 4, unread: 1, supported: true }],
      false,
    );
    expect(result.starred.total).toBe(4);
  });
});

describe("wiring and unchanged behavior", () => {
  const source = readFileSync(new URL("../../routes/mail.tsx", import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const indexSource = readFileSync(new URL("../mail-index.functions.ts", import.meta.url), "utf8");
  const fastCounts = source.slice(
    source.indexOf("const loadCountsFast = useCallback"),
    source.indexOf("// Decide whether this (folder, sort, session) call"),
  );
  const toggleStar = source.slice(
    source.indexOf("async function toggleStar("),
    source.indexOf("async function toggleRead("),
  );

  it("reuses exactly one getCounts and one listIndexCounts call", () => {
    expect(fastCounts.match(/await getCounts\(\{/g)).toHaveLength(1);
    expect(fastCounts.match(/await listIndexCounts\(\{/g)).toHaveLength(1);
    expect(fastCounts).toContain(
      'const starredCount = authoritative.counts.find((c) => c.folder === "starred")',
    );
    expect(fastCounts).toContain("total: isStarCountHot() ? current.total : starredCount.total");
  });

  it("keeps optimistic star and unstar deltas unchanged", () => {
    expect(toggleStar).toContain("const delta = nextStarred ? 1 : -1;");
    expect(toggleStar).toContain("const delta = nextStarred ? -1 : 1;");
    expect(toggleStar).toContain("Math.max(0, cur.total + delta)");
  });

  it("keeps Starred listing on the existing Bridge fallback", () => {
    expect(source).toContain('f !== "starred" &&');
    expect(indexSource).toContain('if (canonical === "starred")');
  });
});
