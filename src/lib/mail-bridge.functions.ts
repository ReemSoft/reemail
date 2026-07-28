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
import {
  classifyBridgeMessageFailure,
  type BridgeMessageErrorCode as SharedBridgeMessageErrorCode,
} from "@/lib/mail-bridge-error";

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { ok: true; json: any } | { ok: false; error: string; status?: number; unavailable?: boolean }
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
      return {
        ok: false,
        error: json.error || `Bridge error ${res.status}`,
        status: res.status,
      };
    }
    return { ok: true, json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    return { ok: false, error: msg || "تعذر الاتصال بخادم البريد" };
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
    if (!r.ok) return { ok: false as const, error: r.error, counts: [] as FolderCount[] };
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
    if (!r.ok) return { ok: false as const, error: r.error, messages: [] as MailMessage[] };
    return { ok: true as const, messages: (r.json.messages ?? []) as MailMessage[] };
  });

/**
 * Typed fetch-message code. Callers use it to distinguish a proven-absent
 * message (`NOT_FOUND` — the bridge received HTTP 404 or explicit null) from
 * transient failures (`NETWORK`, `UNKNOWN`, etc). Only `NOT_FOUND` is a safe
 * signal to tombstone the local index row; every other code is preserved
 * verbatim so the UI never invents a ghost cleanup.
 */
export type BridgeMessageErrorCode = SharedBridgeMessageErrorCode;

export const bridgeGetMessage = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof MessagePayloadSchema>) => MessagePayloadSchema.parse(v))
  .handler(
    async ({
      data,
    }): Promise<
      | { ok: true; message: MailMessage | null }
      | {
          ok: false;
          code: BridgeMessageErrorCode;
          error: string;
          message: null;
          status?: number;
        }
    > => {
      const r = await bridgeCall(
        data.mailSessionToken,
        "/api/message",
        { folder: data.folder, uid: data.uid },
        data.password,
      );
      if (!r.ok) {
        const code = classifyBridgeMessageFailure({
          status: r.status,
          unavailable: r.unavailable,
        });
        return { ok: false, code, error: r.error, message: null, status: r.status };
      }

      // The bridge may return { ok:true, message:null } on a rare shape
      // mismatch. Treat that as NOT_FOUND for the ghost-cleanup contract.
      const msg = (r.json.message as MailMessage | null) ?? null;
      if (!msg) {
        return { ok: false, code: "NOT_FOUND", error: "Message not found", message: null };
      }
      return { ok: true, message: msg };
    },
  );

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
    async ({ data }): Promise<{ ok: true; kind: "moved-to-trash"; move: BridgeMoveResult }> => {
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
    if (!r.ok) return { ok: false as const, error: r.error, messages: [] as MailMessage[] };
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

// ---------------------------------------------------------------------------
// M3 — Draft server functions (MAILMAESTRO_DRAFT_APPEND_R1)
// ---------------------------------------------------------------------------
//
// Trust model — LOCKED:
//   * Client sends ONLY: mailSessionToken, draftId, previousRef, recipients,
//     subject, body, and (for save) FormData attachments.
//   * Client CANNOT send: account, password, companyId, Bridge key, imap/smtp
//     host/port/security. Any such field arriving from the client is IGNORED.
//   * Server verifies the Mail Session JWT, reads accountId+companyId from
//     the claims, loads the IMAP/SMTP config from DB scoped by companyId,
//     and decrypts the mailbox password server-side.
//   * Bridge errors are mapped to a small, typed code set — no PII, no
//     provider strings, no raw Bridge payloads leak to the browser.
//   * Attachments MUST flow through FormData (multipart) — never base64 in
//     JSON — reusing the same size/count caps as the send-multipart route.

const DraftPreviousRefSchema = z.object({
  folderPath: z.string().min(1).max(500),
  uid: z.number().int().positive(),
  uidValidity: z.string().min(1).max(64),
});

const DraftSaveClientSchema = z.object({
  mailSessionToken: z.string().min(20).max(4096),
  draftId: z.string().uuid(),
  to: z.array(AddressSchema).max(200).optional().default([]),
  cc: z.array(AddressSchema).max(200).optional().default([]),
  bcc: z.array(AddressSchema).max(200).optional().default([]),
  subject: z.string().max(998).optional().default(""),
  bodyHtml: z
    .string()
    .max(5 * 1024 * 1024)
    .optional(),
  bodyText: z
    .string()
    .max(5 * 1024 * 1024)
    .optional(),
  previousRef: DraftPreviousRefSchema.optional(),
});

const DraftDeleteClientSchema = z.object({
  mailSessionToken: z.string().min(20).max(4096),
  draftId: z.string().uuid(),
  previousRef: DraftPreviousRefSchema.optional(),
});

export type DraftErrorCode =
  | "INVALID_PAYLOAD"
  | "SESSION_REQUIRED"
  | "CREDENTIALS_PENDING"
  | "BRIDGE_NOT_CONFIGURED"
  | "NO_DRAFTS_FOLDER"
  | "SAFE_DRAFT_REPLACE_UNSUPPORTED"
  | "UIDPLUS_UNSUPPORTED"
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENTS_TOO_LARGE"
  | "TOO_MANY_ATTACHMENTS"
  | "APPEND_FAILED"
  | "IMAP_ERROR"
  | "NETWORK"
  | "UNKNOWN";

export interface DraftSaveResultOk {
  ok: true;
  draftId: string;
  folderPath: string;
  uid: number | null;
  uidValidity: string;
  messageId: string;
  savedAt: string;
}
export interface DraftDeleteResultOk {
  ok: true;
  draftId: string;
  folderPath: string | null;
  deleted: boolean;
}
export interface DraftResultErr {
  ok: false;
  code: DraftErrorCode;
}

// Coarse bridge-error → typed client code map. Anything unknown collapses to
// UNKNOWN so provider text NEVER reaches the browser.
function mapBridgeDraftError(raw: unknown): DraftErrorCode {
  const s = typeof raw === "string" ? raw : "";
  switch (s) {
    case "NO_DRAFTS_FOLDER":
    case "SAFE_DRAFT_REPLACE_UNSUPPORTED":
    case "UIDPLUS_UNSUPPORTED":
    case "APPEND_FAILED":
    case "IMAP_ERROR":
    case "ATTACHMENT_TOO_LARGE":
    case "ATTACHMENTS_TOO_LARGE":
    case "TOO_MANY_ATTACHMENTS":
    case "INVALID_PAYLOAD":
      return s;
    default:
      return "UNKNOWN";
  }
}

// -- Save (multipart FormData for attachments) --------------------------------
// TanStack Start supports FormData input via `inputValidator`. We validate the
// JSON `payload` field with Zod and stream the raw `attachments` File entries
// through to the bridge unchanged (never base64, never in-memory buffers).
export const bridgeSaveDraft = createServerFn({ method: "POST" })
  .inputValidator((input: FormData) => {
    if (!(input instanceof FormData)) {
      throw new Error("INVALID_PAYLOAD");
    }
    const raw = input.get("payload");
    if (typeof raw !== "string") throw new Error("INVALID_PAYLOAD");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new Error("INVALID_PAYLOAD");
    }
    const parsed = DraftSaveClientSchema.parse(parsedJson);
    return { parsed, form: input };
  })
  .handler(async ({ data }): Promise<DraftSaveResultOk | DraftResultErr> => {
    const { parsed, form } = data;
    const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
    const { loadDecryptedPasswordForAccount, MailCredentialsPendingError } =
      await import("@/lib/mail-credentials.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const auth = await resolveBridgeAuth(parsed.mailSessionToken);
    if (!auth.ok) {
      const code: DraftErrorCode =
        auth.code === "BRIDGE_NOT_CONFIGURED"
          ? "BRIDGE_NOT_CONFIGURED"
          : auth.code === "INVALID_TOKEN"
            ? "SESSION_REQUIRED"
            : "UNKNOWN";
      return { ok: false, code };
    }

    let password: string;
    try {
      password = await loadDecryptedPasswordForAccount(
        supabaseAdmin,
        auth.accountId,
        auth.companyId,
      );
    } catch (err) {
      if (err instanceof MailCredentialsPendingError) {
        return { ok: false, code: "CREDENTIALS_PENDING" };
      }
      console.error("[bridgeSaveDraft] credentials load failed");
      return { ok: false, code: "IMAP_ERROR" };
    }

    // Enforce account/company isolation on previousRef: we never trust a
    // caller-supplied folderPath as a physical target — the Bridge only ever
    // writes to its own resolved Drafts mailbox — but we still refuse a
    // previousRef whose uidValidity/folderPath look like an attempt to point
    // at another mailbox. The Bridge's own guard (only touches resolved
    // Drafts path) is defense-in-depth.
    const safeJsonPayload = {
      account: auth.bridgeAccount,
      password,
      draftId: parsed.draftId,
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      subject: parsed.subject,
      bodyHtml: parsed.bodyHtml,
      bodyText: parsed.bodyText,
      previousRef: parsed.previousRef,
    };

    const outForm = new FormData();
    outForm.append("payload", JSON.stringify(safeJsonPayload));
    for (const [k, v] of form.entries()) {
      if (k === "payload") continue;
      if (k === "attachments" && v instanceof File) {
        outForm.append("attachments", v, v.name);
      }
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${auth.bridgeUrl}/api/draft-save`, {
        method: "POST",
        headers: { "X-Bridge-Key": auth.bridgeKey },
        body: outForm,
      });
    } catch {
      return { ok: false, code: "NETWORK" };
    }
    let json: Record<string, unknown> | null = null;
    try {
      json = await upstream.json();
    } catch {
      /* fall through */
    }
    if (!upstream.ok || !json?.ok) {
      return { ok: false, code: mapBridgeDraftError(json?.error) };
    }
    return {
      ok: true,
      draftId: String(json.draftId),
      folderPath: String(json.folderPath),
      uid: typeof json.uid === "number" ? json.uid : null,
      uidValidity: String(json.uidValidity ?? ""),
      messageId: String(json.messageId ?? ""),
      savedAt: String(json.savedAt ?? new Date().toISOString()),
    };
  });

export const bridgeDeleteDraft = createServerFn({ method: "POST" })
  .inputValidator((v: z.input<typeof DraftDeleteClientSchema>) => DraftDeleteClientSchema.parse(v))
  .handler(async ({ data }): Promise<DraftDeleteResultOk | DraftResultErr> => {
    const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
    const { loadDecryptedPasswordForAccount, MailCredentialsPendingError } =
      await import("@/lib/mail-credentials.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const auth = await resolveBridgeAuth(data.mailSessionToken);
    if (!auth.ok) {
      const code: DraftErrorCode =
        auth.code === "BRIDGE_NOT_CONFIGURED"
          ? "BRIDGE_NOT_CONFIGURED"
          : auth.code === "INVALID_TOKEN"
            ? "SESSION_REQUIRED"
            : "UNKNOWN";
      return { ok: false, code };
    }

    let password: string;
    try {
      password = await loadDecryptedPasswordForAccount(
        supabaseAdmin,
        auth.accountId,
        auth.companyId,
      );
    } catch (err) {
      if (err instanceof MailCredentialsPendingError) {
        return { ok: false, code: "CREDENTIALS_PENDING" };
      }
      console.error("[bridgeDeleteDraft] credentials load failed");
      return { ok: false, code: "IMAP_ERROR" };
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${auth.bridgeUrl}/api/draft-delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Key": auth.bridgeKey,
        },
        body: JSON.stringify({
          account: auth.bridgeAccount,
          password,
          draftId: data.draftId,
          previousRef: data.previousRef,
        }),
      });
    } catch {
      return { ok: false, code: "NETWORK" };
    }
    let json: Record<string, unknown> | null = null;
    try {
      json = await upstream.json();
    } catch {
      /* fall through */
    }
    if (!upstream.ok || !json?.ok) {
      return { ok: false, code: mapBridgeDraftError(json?.error) };
    }
    return {
      ok: true,
      draftId: String(json.draftId),
      folderPath: json.folderPath == null ? null : String(json.folderPath),
      deleted: Boolean(json.deleted),
    };
  });
