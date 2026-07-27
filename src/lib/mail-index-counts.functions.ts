// Server function: read per-folder counters from the Local Mail Index.
//
// Replaces the Bridge /api/folders round-trip on Manual Refresh once the
// Local Index is ready. Auth is the same JWT flow as indexListMessages —
// identity comes from verified claims, never from client input.
//
// Client-safe by construction: all server-only imports live inside the
// handler.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { MailFolder } from "@/lib/mail-types";

const InputSchema = z
  .object({
    mailSessionToken: z.string().min(20).max(4096),
  })
  .strict();

export type IndexCountsInput = z.input<typeof InputSchema>;

export interface IndexFolderCount {
  folder: MailFolder;
  total: number;
  unread: number;
  path: string | null;
  /** Server-resolved UIDVALIDITY for the folder, `null` when never synced. */
  uidvalidity: number | null;
  /** Whether the folder row has a resolved uidvalidity (i.e. was ever synced). */
  hasUidvalidity: boolean;
}

export type IndexCountsResult =
  | { ok: true; counts: IndexFolderCount[] }
  | { ok: false; error: string; code: string };

export const indexListFolderCounts = createServerFn({ method: "POST" })
  .inputValidator((v: IndexCountsInput) => InputSchema.parse(v))
  .handler(async ({ data }): Promise<IndexCountsResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { verifyMailSessionToken } = await import("@/lib/mail-token.server");

    let claims;
    try {
      claims = await verifyMailSessionToken(data.mailSessionToken);
    } catch {
      return { ok: false, error: "جلسة البريد غير صالحة أو منتهية.", code: "INVALID_TOKEN" };
    }

    const q = await supabaseAdmin
      .from("mail_folders")
      .select("canonical, total, unread, path, uidvalidity")
      .eq("account_id", claims.sub)
      .eq("company_id", claims.cid);

    if (q.error) {
      console.error("[indexListFolderCounts] query failed", q.error);
      return { ok: false, error: "تعذر قراءة العدادات.", code: "COUNTS_QUERY_FAILED" };
    }

    const counts: IndexFolderCount[] = (q.data ?? [])
      .filter((r) => r.canonical != null)
      .map((r) => ({
        folder: r.canonical as MailFolder,
        total: r.total ?? 0,
        unread: r.unread ?? 0,
        path: r.path ?? null,
        uidvalidity: r.uidvalidity ?? null,
        hasUidvalidity: r.uidvalidity != null,
      }));

    return { ok: true, counts };
  });
