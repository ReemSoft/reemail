// Server functions that proxy user actions to the private Mail Bridge.
//
// Security model (closes bridge_passthrough_open):
//   * Every function REQUIRES a signed Mail Session Token.
//   * accountId + companyId come from verified JWT claims.
//   * IMAP/SMTP host/port/security are loaded from the database by
//     `resolveMailConfigForAccount` inside the handler — the browser can
//     never influence which host the bridge connects to.
//   * The client-facing shapes only change one field: `account` is
//     replaced by `mailSessionToken`. All response shapes are unchanged.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { MailFolder, FolderCount, MailMessage } from "@/lib/mail-types";

const FolderSchema = z.enum([
  "inbox",
  "starred",
  "sent",
  "drafts",
  "spam",
  "trash",
  "archive",
  "all",
]);

const AuthSchema = z.object({
  mailSessionToken: z.string().min(20).max(4096),
  password: z.string().min(1).max(1024),
});

const FolderPayloadSchema = AuthSchema.extend({
  folder: FolderSchema,
  limit: z.number().int().nonnegative().max(500).optional().default(50),
  offset: z.number().int().nonnegative().max(100000).optional().default(0),
  sort: z.enum(["date-desc", "date-asc", "unread-first", "starred-first"]).optional(),
});

const MessagePayloadSchema = AuthSchema.extend({
  folder: FolderSchema,
  uid: z.number().int().positive(),
});

const MarkReadPayloadSchema = MessagePayloadSchema.extend({ read: z.boolean() });
const StarPayloadSchema = MessagePayloadSchema.extend({ starred: z.boolean() });
const MovePayloadSchema = MessagePayloadSchema.extend({ toFolder: FolderSchema });

const AddressSchema = z.object({
  name: z.string().max(256),
  email: z.string().email().max(320),
});

const SendPayloadSchema = AuthSchema.extend({
  to: z.array(AddressSchema).min(1).max(100),
  cc: z.array(AddressSchema).max(100).optional().default([]),
  bcc: z.array(AddressSchema).max(100).optional().default([]),
  subject: z.string().min(1).max(998),
  bodyHtml: z.string().max(2_000_000).optional(),
  bodyText: z.string().max(2_000_000).optional(),
});

const SearchPayloadSchema = AuthSchema.extend({
  folder: FolderSchema,
  query: z.string().min(1).max(1024),
  includeBody: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

async function bridgeCall(
  mailSessionToken: string,
  path: string,
  extraBody: Record<string, unknown>,
  password: string,
): Promise<
  | { ok: true; json: any }
  | { ok: false; error: string; unavailable?: boolean }
> {
  const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
  const auth = await resolveBridgeAuth(mailSessionToken);
  if (!auth.ok) {
    return { ok: false, error: auth.error, unavailable: auth.code === "BRIDGE_NOT_CONFIGURED" };
  }
  try {
    const res = await fetch(`${auth.bridgeUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Key": auth.bridgeKey,
      },
      body: JSON.stringify({
        account: auth.bridgeAccount,
        password,
        ...extraBody,
      }),
    });
    const json = await res.json().catch(() => ({ ok: false, error: "Bridge error" }));
    if (!res.ok || !json.ok) {
      return { ok: false, error: json.error || `Bridge error ${res.status}` };
    }
    return { ok: true, json };
  } catch (err: any) {
    return { ok: false, error: err?.message || "تعذر الاتصال بخادم البريد" };
  }
}

export const bridgeVerify = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof AuthSchema>) => AuthSchema.parse(v))
  .handler(async ({ data }) => {
    const r = await bridgeCall(data.mailSessionToken, "/api/verify", {}, data.password);
    if (!r.ok) return { ok: false, error: r.error };
    return r.json;
  });

export const bridgeGetFolderCounts = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof AuthSchema>) => AuthSchema.parse(v))
  .handler(async ({ data }) => {
    const r = await bridgeCall(data.mailSessionToken, "/api/folders", {}, data.password);
    if (!r.ok)
      return { ok: false as const, error: r.error, counts: [] as FolderCount[] };
    return { ok: true as const, counts: (r.json.counts ?? []) as FolderCount[] };
  });

export type MailSortOption = "date-desc" | "date-asc" | "unread-first" | "starred-first";

export const bridgeGetMessages = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof FolderPayloadSchema>) => FolderPayloadSchema.parse(v))
  .handler(async ({ data }) => {
    const r = await bridgeCall(
      data.mailSessionToken,
      "/api/messages",
      { folder: data.folder, limit: data.limit, offset: data.offset, sort: data.sort },
      data.password,
    );
    if (!r.ok)
      return { ok: false as const, error: r.error, messages: [] as MailMessage[] };
    return { ok: true as const, messages: (r.json.messages ?? []) as MailMessage[] };
  });

export const bridgeGetMessage = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof MessagePayloadSchema>) => MessagePayloadSchema.parse(v))
  .handler(async ({ data }) => {
    const r = await bridgeCall(
      data.mailSessionToken,
      "/api/message",
      { folder: data.folder, uid: data.uid },
      data.password,
    );
    if (!r.ok)
      return {
        ok: false as const,
        error: r.error,
        message: null as MailMessage | null,
      };
    return { ok: true as const, message: (r.json.message as MailMessage | null) ?? null };
  });

export const bridgeMarkRead = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof MarkReadPayloadSchema>) => MarkReadPayloadSchema.parse(v))
  .handler(async ({ data }) => {
    const r = await bridgeCall(
      data.mailSessionToken,
      "/api/mark-read",
      { folder: data.folder, uid: data.uid, read: data.read },
      data.password,
    );
    if (!r.ok) throw new Error(r.error || "فشل تحديث حالة القراءة على الخادم");
    return r.json;
  });

export const bridgeStar = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof StarPayloadSchema>) => StarPayloadSchema.parse(v))
  .handler(async ({ data }) => {
    const r = await bridgeCall(
      data.mailSessionToken,
      "/api/star",
      { folder: data.folder, uid: data.uid, starred: data.starred },
      data.password,
    );
    if (!r.ok) throw new Error(r.error || "فشل تحديث المميّز على الخادم");
    return r.json;
  });

/**
 * Bridge move-result contract (mirror of MoveResult in bridge/src/imap.ts).
 * `uidMappingAvailable === true` guarantees a real `destinationUid` from
 * an IMAP UIDPLUS COPYUID response — never invent one on the client.
 */
export interface BridgeMoveResult {
  sourceUid: number;
  destinationPath?: string;
  destinationUid?: number;
  destinationUidValidity?: string;
  uidMappingAvailable: boolean;
}

export const bridgeMove = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof MovePayloadSchema>) => MovePayloadSchema.parse(v))
  .handler(async ({ data }): Promise<{ ok: true; move: BridgeMoveResult }> => {
    const r = await bridgeCall(
      data.mailSessionToken,
      "/api/move",
      { folder: data.folder, uid: data.uid, toFolder: data.toFolder },
      data.password,
    );
    if (!r.ok) throw new Error(r.error || "فشل نقل الرسالة");
    const move = (r.json.move as BridgeMoveResult | undefined) ?? {
      sourceUid: data.uid,
      uidMappingAvailable: false,
    };
    return { ok: true, move };
  });

export const bridgeDelete = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof MessagePayloadSchema>) => MessagePayloadSchema.parse(v))
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; kind: "moved-to-trash"; move: BridgeMoveResult }> => {
      const r = await bridgeCall(
        data.mailSessionToken,
        "/api/delete",
        { folder: data.folder, uid: data.uid },
        data.password,
      );
      if (!r.ok) throw new Error(r.error || "فشل حذف الرسالة");
      const move = (r.json.move as BridgeMoveResult | undefined) ?? {
        sourceUid: data.uid,
        uidMappingAvailable: false,
      };
      const kind = (r.json.kind as "moved-to-trash" | undefined) ?? "moved-to-trash";
      return { ok: true, kind, move };
    },
  );

export const bridgeSearch = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof SearchPayloadSchema>) => SearchPayloadSchema.parse(v))
  .handler(async ({ data }) => {
    const r = await bridgeCall(
      data.mailSessionToken,
      "/api/search",
      {
        folder: data.folder,
        query: data.query,
        includeBody: data.includeBody,
        limit: data.limit,
      },
      data.password,
    );
    if (!r.ok)
      return { ok: false as const, error: r.error, messages: [] as MailMessage[] };
    return { ok: true as const, messages: (r.json.messages ?? []) as MailMessage[] };
  });

export const bridgeSend = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof SendPayloadSchema>) => SendPayloadSchema.parse(v))
  .handler(async ({ data }) => {
    const r = await bridgeCall(
      data.mailSessionToken,
      "/api/send",
      {
        to: data.to,
        cc: data.cc,
        bcc: data.bcc,
        subject: data.subject,
        bodyHtml: data.bodyHtml,
        bodyText: data.bodyText,
      },
      data.password,
    );
    if (!r.ok) return { ok: false, error: r.error };
    return r.json;
  });
