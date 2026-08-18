// Server function: read one page of the Local Mail Index for a folder.
//
// Auth model matches runMailSync: caller sends the short-lived Mail Session
// Token; identity (accountId, companyId) comes from verified claims.
//
// Pagination: keyset cursor over (internal_date DESC, id DESC). Callers pass
// back the opaque `nextCursor` from the previous page to fetch the next slice.
//
// This module is client-safe by construction — all server-only imports live
// inside the handler.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { MailFolder, MailMessage } from "@/lib/mail-types";

const CANONICAL_FOLDERS = [
  "inbox",
  "starred",
  "sent",
  "drafts",
  "spam",
  "trash",
  "archive",
  "all",
] as const;

const InputSchema = z
  .object({
    mailSessionToken: z.string().min(20).max(4096),
    canonical: z.enum(CANONICAL_FOLDERS),
    limit: z.number().int().positive().max(200).default(50),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

export type IndexListInput = z.input<typeof InputSchema>;

export type IndexListResult =
  | {
      ok: true;
      indexed: true;
      messages: MailMessage[];
      nextCursor: string | null;
      hasMore: boolean;
      folderId: string;
      total: number;
      unread: number;
    }
  | { ok: true; indexed: false; reason: "NO_FOLDER" | "NO_UIDVALIDITY" | "AMBIGUOUS_FOLDER" }
  | { ok: false; error: string; code: string };

export const indexListMessages = createServerFn({ method: "POST" })
  .inputValidator((input: IndexListInput) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<IndexListResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
    const { indexRowToMailMessage, encodeIndexCursor, decodeIndexCursor } =
      await import("@/lib/mail-index-row");

    // ---- 1) Verify token ----
    let claims;
    try {
      claims = await verifyMailSessionToken(data.mailSessionToken);
    } catch {
      return { ok: false, error: "جلسة البريد غير صالحة أو منتهية.", code: "INVALID_TOKEN" };
    }
    const accountId = claims.sub;
    const companyId = claims.cid;
    const canonical = data.canonical as MailFolder;

    // ---- 1.5) Starred is a virtual IMAP view (INBOX + \Flagged) that
    // shares its mailbox path with "inbox". In the current Local Index
    // schema, `mail_folders` is uniquely keyed by (account_id, path), so
    // there is no distinct row for starred — the INBOX row wins on first
    // sync and canonical='starred' effectively never resolves. Serving
    // starred from the index today would either return zero rows or
    // (worse) return all inbox rows regardless of the \Flagged flag.
    // Bail out cleanly and force the caller to use the bridge listing,
    // which honours \Flagged natively.
    if (canonical === "starred") {
      return { ok: true, indexed: false, reason: "NO_FOLDER" };
    }

    // ---- 2) Resolve folder row by (account_id, canonical) ----
    // `.limit(2)` (instead of `.maybeSingle()`) so a duplicate-canonical
    // corruption (two physical folders sharing one canonical) degrades into a
    // clean Bridge fallback rather than a server error — the trusted sync then
    // repairs the classification (MAILMAESTRO_CANONICAL_SELFHEAL). We never
    // serve an arbitrary row from a duplicate set.
    const folderQ = await supabaseAdmin
      .from("mail_folders")
      .select("id, uidvalidity, total, unread")
      .eq("account_id", accountId)
      .eq("company_id", companyId)
      .eq("canonical", canonical)
      .limit(2);
    if (folderQ.error) {
      console.error("[indexListMessages] folder lookup failed", folderQ.error);
      return { ok: false, error: "تعذر قراءة المجلد.", code: "FOLDER_QUERY_FAILED" };
    }
    const folderRows = (folderQ.data ?? []) as Array<{
      id: string;
      uidvalidity: number | string | null;
      total: number;
      unread: number;
    }>;
    if (folderRows.length === 0) return { ok: true, indexed: false, reason: "NO_FOLDER" };
    if (folderRows.length > 1) {
      return { ok: true, indexed: false, reason: "AMBIGUOUS_FOLDER" };
    }
    const folderRow = folderRows[0];
    if (folderRow.uidvalidity == null)
      return { ok: true, indexed: false, reason: "NO_UIDVALIDITY" };

    const folderId = folderRow.id;
    const folderUidValidity = String(folderRow.uidvalidity);

    // ---- 3) Keyset cursor page ----
    const cursor = data.cursor ? decodeIndexCursor(data.cursor) : null;
    const limit = data.limit;

    let q = supabaseAdmin
      .from("mail_messages")
      .select(
        "id, uid, subject, from_addr, to_addrs, cc_addrs, internal_date, seen, flagged, has_attachments, message_id, in_reply_to, references_ids",
      )
      .eq("account_id", accountId)
      .eq("company_id", companyId)
      .eq("folder_id", folderId)
      .is("deleted_at", null)
      .order("internal_date", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false })
      .limit(limit + 1);

    // drafts must only expose rows from the current mailbox uidvalidity.
    // stale legacy rows from an older uidvalidity are not current drafts.
    if (canonical === "drafts") {
      q = q.eq("uidvalidity", +folderUidValidity);
    }

    if (cursor) {
      // Keyset: (internal_date, id) < (cursor.date, cursor.id)
      // Emulated via OR because PostgREST lacks tuple comparison.
      q = q.or(
        `internal_date.lt.${cursor.date},and(internal_date.eq.${cursor.date},id.lt.${cursor.id})`,
      );
    }

    const pageQ = await q;
    if (pageQ.error) {
      console.error("[indexListMessages] page query failed", pageQ.error);
      return { ok: false, error: "تعذر قراءة الرسائل.", code: "PAGE_QUERY_FAILED" };
    }
    const rows = pageQ.data ?? [];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const messages = pageRows.map((r) => ({
      ...indexRowToMailMessage(canonical, {
        uid: Number(r.uid),
        subject: r.subject,
        from_addr: r.from_addr,
        to_addrs: r.to_addrs,
        cc_addrs: r.cc_addrs,
        internal_date: r.internal_date,
        seen: !!r.seen,
        flagged: !!r.flagged,
        has_attachments: !!r.has_attachments,
        message_id: r.message_id,
        in_reply_to: r.in_reply_to,
        references_ids: r.references_ids,
      }),
      uidValidity: folderUidValidity,
    }));

    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last && last.internal_date
        ? encodeIndexCursor({ date: last.internal_date, id: String(last.id) })
        : null;

    return {
      ok: true,
      indexed: true,
      messages,
      nextCursor,
      hasMore,
      folderId,
      total: folderRow.total ?? 0,
      unread: folderRow.unread ?? 0,
    };
  });
