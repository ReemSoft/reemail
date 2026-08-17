import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import { uploadStorage, cleanupFiles, startupCleanup } from "./uploads.js";
import { cleanupStaleMimeSpools } from "./mime-spool.js";
import { accountBinding, openTransferTicket, sealTransferTicket } from "./transfer-tickets.js";
import {
  cleanupSendStagedAttachments,
  cleanupStagedAttachments,
  releaseStagedAttachments,
  resolveStagedAttachment,
  stageAttachmentStream,
  stagedAttachmentStats,
  validateStagedHandle,
  type ResolvedStagedAttachment,
} from "./staged-attachments.js";

import { configuredAppOrigins, isAllowedAppOrigin, publicBridgeBase } from "./public-bridge-url.js";
import { TransferConcurrency } from "./transfer-concurrency.js";
import {
  stageServerAttachmentSources,
  stageDraftServerAttachmentSources,
  stageServerInlineSources,
  draftSourceHandlesToRelease,
  rebindServerSourcesToCanonicalDraft,
} from "./server-attachment-sources.js";
import { pipeline } from "node:stream/promises";
import { attachmentContentDisposition, sanitizeAttachmentFilename } from "./attachment-transfer.js";
import { DownloadByteCounter, parseDownloadChunkBytes } from "./download-performance.js";
import { createSendGates } from "./concurrency.js";
import {
  createImapGates,
  ImapBusyError,
  loadImapGatesConfigFromEnv,
  type ImapPriority,
} from "./imap-gates.js";
import { createImapGateMiddleware } from "./imap-gate-middleware.js";
import {
  LatestMessageOpenTracker,
  MessageOpenSingleFlight,
  type MessageOpenIntentLease,
} from "./message-open-intent.js";

import { z } from "zod";
import {
  verifyCredentials,
  getFolderCounts,
  getMessages,
  getMessageBody,
  getMessageBodiesBatch,
  getEntireMessageBody,
  MessageBodyTooLargeError,
  getInlineImagesBatch,
  getLargeInlinePart,
  getLargeInlinePartsBatch,
  markRead,
  starMessage,
  moveMessage,
  deleteMessage,
  searchMessages,
  getSenderMessagesPage,
  downloadAttachment,
  resolveFolderPath,
  type InlinePartMetadata,
} from "./imap.js";
import {
  closeAllImapConnections,
  dropAccountConnection,
  getMailboxesCached,
  MessageOpenSupersededError,
  TIMING_ENABLED,
  withAccountMailbox,
} from "./imap-connection.js";
import { sendMessage, sendMessageFast, sentCopyAccountKey } from "./smtp.js";
import { classifyAttachmentValidationFailure } from "./attachment-validation.js";
import { postSendFinalizers } from "./post-send-finalizer.js";
import { mapUploadedAttachments } from "./inline-images.js";
import {
  DraftSavePayloadSchema,
  DraftDeletePayloadSchema,
  DraftTriggerDiagnosticsSchema,
  saveDraft,
  reconcileDraftRevision,
  deleteDraft,
} from "./drafts.js";
import type { MailAccount, MailFolder } from "./types.js";
import {
  InitialSyncSchema,
  IncrementalSyncSchema,
  ReconcileSyncSchema,
  runInitialSync,
  runIncrementalSync,
  runReconcileSync,
  safeError,
} from "./sync.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || "";

if (!BRIDGE_API_KEY) {
  console.warn("[bridge] Warning: BRIDGE_API_KEY is not set. Server will reject all requests.");
}

const allowedOrigins = configuredAppOrigins();
app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedAppOrigin(origin, allowedOrigins)) {
        callback(null, true);
      } else {
        callback(new Error("CORS_ORIGIN_DENIED"));
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Bridge-Key"],
    exposedHeaders: ["Server-Timing", "X-MailMaestro-Stage-Ms"],
    credentials: false,
  }),
);
const jsonParser = express.json({ limit: "25mb" });
const urlencodedParser = express.urlencoded({ extended: true, limit: "25mb" });
app.use((req, res, next) =>
  req.path === "/api/direct/attachment-upload" ? next() : jsonParser(req, res, next),
);
app.use((req, res, next) =>
  req.path === "/api/direct/attachment-upload" ? next() : urlencodedParser(req, res, next),
);

// --- Validation schemas ---
const AccountSchema = z.object({
  email_address: z.string().email(),
  display_name: z.string().optional().nullable(),
  imap_host: z.string().min(1),
  imap_port: z.number().int().positive(),
  imap_secure: z.boolean().default(true),
  smtp_host: z.string().min(1),
  smtp_port: z.number().int().positive(),
  smtp_secure: z.boolean().default(true),
});

const AuthPayloadSchema = z.object({
  account: AccountSchema,
  password: z.string().min(1),
});

const SendStatusPayloadSchema = z.object({
  account: AccountSchema,
  jobId: z.string().min(32).max(128),
});

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

const FolderPayloadSchema = AuthPayloadSchema.extend({
  folder: FolderSchema,
});

const MessagePayloadSchema = FolderPayloadSchema.extend({
  uid: z.number().int().positive(),
});

const MessagePrefetchPayloadSchema = FolderPayloadSchema.extend({
  uids: z.array(z.number().int().positive()).min(1).max(12),
});

const InlinePartSchema = z.object({
  cid: z.string().min(1).max(998),
  part: z.string().regex(/^\d+(?:\.\d+)*$/),
  mimeType: z.string().regex(/^image\//i),
  size: z
    .number()
    .int()
    .min(0)
    .max(256 * 1024),
});

const InlineBatchPayloadSchema = MessagePayloadSchema.extend({
  expectedUidValidity: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(64),
  parts: z.array(InlinePartSchema).max(20),
});

const LargeInlinePartPayloadSchema = MessagePayloadSchema.extend({
  expectedUidValidity: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(64),
  part: z.string().regex(/^\d+(?:\.\d+)*$/),
});

const LargeInlinePartsPayloadSchema = MessagePayloadSchema.extend({
  expectedUidValidity: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(64),
  parts: z
    .array(
      z.object({
        cid: z.string().min(1).max(998),
        part: z.string().regex(/^\d+(?:\.\d+)*$/),
        mimeType: z.string().regex(/^image\/(?:png|jpe?g|gif|webp)$/i),
        size: z
          .number()
          .int()
          .min(0)
          .max(5 * 1024 * 1024),
      }),
    )
    .min(1)
    .max(20),
}).superRefine((value, context) => {
  if (value.parts.reduce((total, part) => total + part.size, 0) > 25 * 1024 * 1024) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "INLINE_BATCH_TOO_LARGE" });
  }
});

const MarkReadPayloadSchema = MessagePayloadSchema.extend({
  read: z.boolean(),
});

const StarPayloadSchema = MessagePayloadSchema.extend({
  starred: z.boolean(),
});

const MovePayloadSchema = MessagePayloadSchema.extend({
  toFolder: FolderSchema,
});

const SendPayloadSchema = AuthPayloadSchema.extend({
  to: z.array(z.object({ name: z.string(), email: z.string().email() })),
  cc: z
    .array(z.object({ name: z.string(), email: z.string().email() }))
    .optional()
    .default([]),
  bcc: z
    .array(z.object({ name: z.string(), email: z.string().email() }))
    .optional()
    .default([]),
  subject: z.string().min(1),
  inReplyTo: z.string().min(3).max(998).optional(),
  references: z.array(z.string().min(3).max(998)).max(100).optional().default([]),
  bodyHtml: z.string().optional(),
  bodyText: z.string().optional(),
  inlineImages: z.unknown().optional(),
});

const UploadTicketPayloadSchema = z.object({
  account: AccountSchema,
  filename: z.string().min(1).max(255),
  size: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024),
  mimeType: z.string().min(1).max(255),
  kind: z.enum(["attachment", "inline-image"]),
});

const StagedInlineSchema = z.object({
  handle: z
    .string()
    .min(20)
    .max(32 * 1024),
  uploadFilename: z.string().min(1).max(255),
  cid: z.string().min(1).max(998),
  contentType: z.string().min(1).max(255),
});

const ServerAttachmentSourceSchema = z.object({
  folderPath: z.string().min(1).max(500),
  uid: z.number().int().positive(),
  uidValidity: z.string().min(1).max(64),
  part: z.string().regex(/^\d+(?:\.\d+)*$/),
  filename: z.string().min(1).max(255),
  size: z
    .number()
    .int()
    .min(0)
    .max(25 * 1024 * 1024),
  mimeType: z.string().min(1).max(255),
});

const ServerInlineSourceSchema = ServerAttachmentSourceSchema.extend({
  uploadFilename: z.string().min(1).max(255),
  cid: z.string().min(1).max(255),
});

const SendV2PayloadSchema = SendPayloadSchema.extend({
  attachmentHandles: z
    .array(
      z
        .string()
        .min(20)
        .max(32 * 1024),
    )
    .max(10)
    .default([]),
  stagedInlineImages: z.array(StagedInlineSchema).max(20).default([]),
  sourceAttachments: z.array(ServerAttachmentSourceSchema).max(10).default([]),
});

// Draft-only: a kept server source may carry a staged handle as a reuse hint.
// Send keeps the strict handle-or-source contract untouched.
const DraftServerAttachmentSourceSchema = ServerAttachmentSourceSchema.extend({
  handle: z
    .string()
    .min(20)
    .max(32 * 1024)
    .optional(),
});
const DraftServerInlineSourceSchema = DraftServerAttachmentSourceSchema.extend({
  uploadFilename: z.string().min(1).max(255),
  cid: z.string().min(1).max(255),
});

const DraftV2AttachmentSchema = z.object({
  attachmentHandles: z
    .array(
      z
        .string()
        .min(20)
        .max(32 * 1024),
    )
    .max(10)
    .default([]),
  stagedInlineImages: z.array(StagedInlineSchema).max(20).default([]),
  sourceAttachments: z.array(DraftServerAttachmentSourceSchema).max(10).default([]),
  sourceInlineImages: z.array(DraftServerInlineSourceSchema).max(20).default([]),
});

const DraftRevisionReconcilePayloadSchema = AuthPayloadSchema.extend({
  draftId: z.string().uuid(),
  revisionId: z.string().uuid(),
});

const DownloadTicketPayloadSchema = MessagePayloadSchema.extend({
  part: z.string().regex(/^\d+(?:\.\d+)*$/),
  mode: z.enum(["download", "preview"]),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  size: z
    .number()
    .int()
    .min(0)
    .max(50 * 1024 * 1024),
});

const DownloadCapabilityDataSchema = DownloadTicketPayloadSchema;

// --- Middleware ---
function requireKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = req.headers["x-bridge-key"] || req.headers["authorization"];
  if (!BRIDGE_API_KEY) {
    return res.status(503).json({ error: "Bridge not configured: missing BRIDGE_API_KEY" });
  }
  if (key !== BRIDGE_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// --- IMAP concurrency limiter (MAILMAESTRO_IMAP_LIMITER_R3) ---
//
// One slot per real IMAP connection. `interactive` is user-facing; `background`
// is Worker sync. Waiters that overflow / time out / are cancelled fail fast
// with HTTP 503 + `IMAP_BUSY`, which the queue backoff classifier already
// treats as a transient retry (via the "busy" string match).
const imapGatesConfig = loadImapGatesConfigFromEnv();
const imapGates = createImapGates(imapGatesConfig);
if (imapGatesConfig.enabled) {
  console.log(
    `[bridge] IMAP gates enabled — global=${imapGatesConfig.globalMax} host=${imapGatesConfig.perHostMax} company=${imapGatesConfig.perCompanyMax} account=${imapGatesConfig.perAccountMax}`,
  );
}

function imapGate(priority: ImapPriority): express.RequestHandler {
  return createImapGateMiddleware(imapGates, priority);
}

// --- Routes ---
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Bounded, side-effect-free limiter metrics. No PII (no emails, no company ids
// beyond aggregated in-flight counts by host). Auth-gated to keep it internal.
app.get("/api/metrics/imap-gates", requireKey, (_req, res) => {
  res.json({
    ok: true,
    gates: imapGates.stats(),
    uploads: directUploadGate.stats(),
    downloads: { active: downloadGates.inFlight() },
    staging: stagedAttachmentStats(),
    sentFinalizers: postSendFinalizers.stats(),
  });
});

app.post("/api/verify", requireKey, imapGate("interactive"), async (req, res) => {
  try {
    const payload = AuthPayloadSchema.parse(req.body);
    const result = await verifyCredentials(payload.account as any, payload.password);
    if (!result.ok && "error" in result) {
      return res.status(401).json({ ok: false, error: result.error });
    }
    return res.json({ ok: true, displayName: result.displayName });
  } catch (err: any) {
    return res.status(400).json({ ok: false, error: err?.message || "Invalid request" });
  }
});

app.post("/api/folders", requireKey, imapGate("interactive"), async (req, res) => {
  try {
    const payload = AuthPayloadSchema.parse(req.body);
    const counts = await getFolderCounts(payload.account as any, payload.password);
    return res.json({ ok: true, counts });
  } catch (err: any) {
    console.error("[bridge] /api/folders error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to list folders" });
  }
});

const SortOptionSchema = z.enum(["date-desc", "date-asc", "unread-first", "starred-first"]);

app.post("/api/messages", requireKey, imapGate("interactive"), async (req, res) => {
  try {
    const payload = FolderPayloadSchema.parse(req.body);
    const sort = SortOptionSchema.optional().parse(req.body.sort) ?? "date-desc";
    const messages = await getMessages(payload.account as any, payload.password, payload.folder, {
      limit: req.body.limit ?? 50,
      offset: req.body.offset ?? 0,
      sort,
    });
    return res.json({ ok: true, messages });
  } catch (err: any) {
    console.error("[bridge] /api/messages error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to fetch messages" });
  }
});

const OpenMessagePayloadSchema = MessagePayloadSchema.extend({
  lane: z.enum(["interactive", "background"]).optional().default("interactive"),
  mailboxPathHint: z.string().max(500).optional(),
  expectedUidValidity: z.string().max(64).optional(),
  openIntentScope: z.string().uuid().optional(),
  openIntentGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  openIntentCompanyId: z.string().uuid().optional(),
  openIntentAccountId: z.string().uuid().optional(),
}).superRefine((value, context) => {
  const fields = [
    value.openIntentScope,
    value.openIntentGeneration,
    value.openIntentCompanyId,
    value.openIntentAccountId,
  ];
  if (fields.some((field) => field != null) && fields.some((field) => field == null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Incomplete message-open intent" });
  }
});

const MessageOpenIntentSchema = z.object({
  folder: FolderSchema,
  uid: z.number().int().positive(),
  lane: z.enum(["interactive", "background"]).optional().default("interactive"),
  openIntentScope: z.string().uuid().optional(),
  openIntentGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  openIntentCompanyId: z.string().uuid().optional(),
  openIntentAccountId: z.string().uuid().optional(),
});

const latestMessageOpenTracker = new LatestMessageOpenTracker();
const messageOpenFlights = new MessageOpenSingleFlight<
  Awaited<ReturnType<typeof getMessageBody>>
>();

type MessageOpenLocals = {
  intent?: MessageOpenIntentLease;
  flightKey?: string;
};

const registerMessageOpenIntent: express.RequestHandler = (req, res, next) => {
  const parsed = MessageOpenIntentSchema.safeParse(req.body);
  if (
    !parsed.success ||
    parsed.data.lane === "background" ||
    !parsed.data.openIntentScope ||
    !parsed.data.openIntentGeneration ||
    !parsed.data.openIntentCompanyId ||
    !parsed.data.openIntentAccountId
  ) {
    return next();
  }
  const scopeKey = `${parsed.data.openIntentCompanyId}|${parsed.data.openIntentAccountId}|${parsed.data.openIntentScope}`;
  const messageIdentity = `${parsed.data.folder}:${parsed.data.uid}`;
  const locals = res.locals as MessageOpenLocals;
  locals.intent = latestMessageOpenTracker.register(
    scopeKey,
    parsed.data.openIntentGeneration!,
    messageIdentity,
  );
  locals.flightKey = `${scopeKey}|${messageIdentity}`;
  return next();
};

const EntireMessagePayloadSchema = MessagePayloadSchema.extend({
  mailboxPathHint: z.string().max(500).optional(),
  expectedUidValidity: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(64)
    .optional(),
}).strict();

/**
 * Lane-aware gate: a background body-warm request must never consume the
 * reserved BODY permit. Explicit body opens (current message / Previous
 * Message expansion) use the reserved `body` class; background warming uses
 * `background`.
 */
const messageGate: express.RequestHandler = (req, res, next) => {
  const lane = (req.body as { lane?: string } | undefined)?.lane;
  const gate = lane === "background" ? imapGate("background") : imapGate("body");
  return gate(req, res, next);
};

app.post("/api/message", requireKey, registerMessageOpenIntent, messageGate, async (req, res) => {
  try {
    const tOpen = Date.now();
    const payload = OpenMessagePayloadSchema.parse(req.body);
    const locals = res.locals as MessageOpenLocals;
    if (locals.intent && !locals.intent.isCurrent()) {
      return res.status(409).json({ ok: false, error: "MESSAGE_OPEN_SUPERSEDED" });
    }
    const open = () =>
      getMessageBody(
        payload.account as MailAccount,
        payload.password,
        payload.folder,
        payload.uid,
        payload.lane,
        payload.mailboxPathHint && payload.expectedUidValidity
          ? {
              path: payload.mailboxPathHint,
              expectedUidValidity: payload.expectedUidValidity,
            }
          : undefined,
        locals.intent?.isCurrent,
      );
    const result = locals.flightKey
      ? await messageOpenFlights.run(locals.flightKey, open)
      : { value: await open(), leader: true };
    if (TIMING_ENABLED) {
      const flightKey = locals.flightKey;
      if (flightKey && !result.leader) {
        // A concurrent interactive open for the exact same message is already
        // running — measure how long this request waited for that leader.
        console.log(`[imap-timing] lane=interactive single-flight-wait ${Date.now() - tOpen}ms`);
      }
    }
    const message = result.value;
    if (!message) {
      return res.status(404).json({ ok: false, error: "Message not found" });
    }
    return res.json({ ok: true, message, shared: !result.leader });
  } catch (err: any) {
    if (err instanceof MessageOpenSupersededError) {
      return res.status(409).json({ ok: false, error: err.code });
    }
    console.error("[bridge] /api/message error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to fetch message" });
  }
});

app.post("/api/messages-prefetch", requireKey, async (req, res) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  try {
    const payload = MessagePrefetchPayloadSchema.parse(req.body);
    const rawAccount = ((req.body as { account?: Record<string, unknown> }).account ??
      {}) as Record<string, unknown>;
    const results = await getMessageBodiesBatch(
      payload.account as MailAccount,
      payload.password,
      payload.folder,
      payload.uids,
      async (worker) => {
        const gateStart = Date.now();
        const release = await imapGates.acquire({
          host: String(rawAccount.imap_host ?? "unknown"),
          company: String(rawAccount.company_id ?? rawAccount.companyId ?? ""),
          account: String(rawAccount.email_address ?? "unknown"),
          priority: "background",
          signal: controller.signal,
        });
        if (TIMING_ENABLED)
          console.log(`[imap-timing] lane=background gate-wait ${Date.now() - gateStart}ms`);
        try {
          return await worker();
        } finally {
          release();
        }
      },
    );
    return res.json({ ok: true, results });
  } catch (err: unknown) {
    if (err instanceof ImapBusyError) {
      res.setHeader("Retry-After", String(err.retryAfterSeconds));
      return res.status(503).json({ ok: false, error: "IMAP_BUSY" });
    }
    if (err instanceof z.ZodError) {
      return res.status(400).json({ ok: false, error: "INVALID_PAYLOAD" });
    }
    console.error("[bridge] /api/messages-prefetch error:", err);
    return res.status(500).json({ ok: false, error: "Failed to prefetch messages" });
  } finally {
    req.off("aborted", abort);
    res.off("close", abort);
  }
});

app.post("/api/message-entire", requireKey, imapGate("body"), async (req, res) => {
  try {
    const payload = EntireMessagePayloadSchema.parse(req.body);
    const body = await getEntireMessageBody(
      payload.account as MailAccount,
      payload.password,
      payload.folder,
      payload.uid,
      payload.mailboxPathHint && payload.expectedUidValidity
        ? {
            path: payload.mailboxPathHint,
            expectedUidValidity: payload.expectedUidValidity,
          }
        : undefined,
    );
    if (!body) return res.status(404).json({ ok: false, error: "Message not found" });
    return res.json({ ok: true, ...body });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ ok: false, error: "INVALID_PAYLOAD" });
    }
    if (err instanceof MessageBodyTooLargeError) {
      return res.status(413).json({ ok: false, error: err.code });
    }
    console.error("[bridge] /api/message-entire error:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch entire message" });
  }
});

app.post("/api/message-inline-images", requireKey, imapGate("media"), async (req, res) => {
  try {
    const payload = InlineBatchPayloadSchema.parse(req.body);
    const result = await getInlineImagesBatch(
      payload.account as MailAccount,
      payload.password,
      payload.folder,
      payload.uid,
      payload.parts as InlinePartMetadata[],
      payload.expectedUidValidity,
    );
    return res.json({ ok: true, ...result });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ ok: false, error: "INVALID_PAYLOAD" });
    }
    console.error("[bridge] /api/message-inline-images error:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch inline images" });
  }
});

app.post("/api/message-inline-part", requireKey, imapGate("media"), async (req, res) => {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once("aborted", abort);
  res.once("close", abort);
  try {
    const payload = LargeInlinePartPayloadSchema.parse(req.body);
    const result = await getLargeInlinePart(
      payload.account as MailAccount,
      payload.password,
      payload.folder,
      payload.uid,
      payload.part,
      payload.expectedUidValidity,
      controller.signal,
    );
    if (controller.signal.aborted) return;
    if (!result) {
      return res.status(404).json({ ok: false, error: "INLINE_IMAGE_UNAVAILABLE" });
    }
    res.setHeader("Content-Type", result.mimeType);
    res.setHeader("Content-Length", String(result.bytes.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(result.bytes);
  } catch (err: unknown) {
    if (controller.signal.aborted) return;
    if (err instanceof z.ZodError) {
      return res.status(400).json({ ok: false, error: "INVALID_PAYLOAD" });
    }
    console.error("[bridge] /api/message-inline-part error:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch inline image" });
  } finally {
    req.off("aborted", abort);
    res.off("close", abort);
  }
});

app.post("/api/message-inline-parts", requireKey, imapGate("media"), async (req, res) => {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once("aborted", abort);
  res.once("close", abort);
  try {
    const payload = LargeInlinePartsPayloadSchema.parse(req.body);
    const result = await getLargeInlinePartsBatch(
      payload.account as MailAccount,
      payload.password,
      payload.folder,
      payload.uid,
      payload.parts as InlinePartMetadata[],
      payload.expectedUidValidity,
      controller.signal,
    );
    if (controller.signal.aborted) return;
    const boundary = `mm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const chunks: Buffer[] = [];
    const metadata = result.images.map((image, index) => ({
      index,
      cid: image.cid,
      part: image.part,
      mimeType: image.mimeType,
      size: image.bytes.length,
    }));
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ images: metadata, failedCids: result.failedCids })}\r\n`,
      ),
    );
    result.images.forEach((image, index) => {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="image-${index}"; filename="${index}"\r\nContent-Type: ${image.mimeType}\r\n\r\n`,
        ),
        image.bytes,
        Buffer.from("\r\n"),
      );
    });
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);
    res.setHeader("Content-Type", `multipart/form-data; boundary=${boundary}`);
    res.setHeader("Content-Length", String(body.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(body);
  } catch (err: unknown) {
    if (controller.signal.aborted) return;
    if (err instanceof z.ZodError)
      return res.status(400).json({ ok: false, error: "INVALID_PAYLOAD" });
    console.error("[bridge] /api/message-inline-parts error:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch inline images" });
  } finally {
    req.off("aborted", abort);
    res.off("close", abort);
  }
});

app.post("/api/mark-read", requireKey, imapGate("interactive"), async (req, res) => {
  try {
    const payload = MarkReadPayloadSchema.parse(req.body);
    await markRead(
      payload.account as MailAccount,
      payload.password,
      payload.folder,
      payload.uid,
      payload.read,
    );
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("[bridge] /api/mark-read error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to update message" });
  }
});

app.post("/api/star", requireKey, imapGate("interactive"), async (req, res) => {
  try {
    const payload = StarPayloadSchema.parse(req.body);
    await starMessage(
      payload.account as MailAccount,
      payload.password,
      payload.folder,
      payload.uid,
      payload.starred,
    );
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("[bridge] /api/star error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to update message" });
  }
});

app.post("/api/move", requireKey, imapGate("interactive"), async (req, res) => {
  try {
    const payload = MovePayloadSchema.parse(req.body);
    const move = await moveMessage(
      payload.account as MailAccount,
      payload.password,
      payload.folder,
      payload.uid,
      payload.toFolder,
    );
    // Backward-compat: existing callers only check `ok`. New callers can
    // read `move.destinationUid` when `move.uidMappingAvailable === true`.
    return res.json({ ok: true, move });
  } catch (err: any) {
    console.error("[bridge] /api/move error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to move message" });
  }
});

app.post("/api/delete", requireKey, imapGate("interactive"), async (req, res) => {
  try {
    const payload = MessagePayloadSchema.parse(req.body);
    const result = await deleteMessage(
      payload.account as any,
      payload.password,
      payload.folder,
      payload.uid,
    );
    // Blocker 1 contract:
    //   trash source → { ok:true, kind:"permanent-delete", sourceUid }
    //   other        → { ok:true, kind:"moved-to-trash",  move: MoveResult }
    if (result.kind === "permanent-delete") {
      return res.json({ ok: true, kind: result.kind, sourceUid: result.sourceUid });
    }
    return res.json({ ok: true, kind: result.kind, move: result.move });
  } catch (err: any) {
    console.error("[bridge] /api/delete error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to delete message" });
  }
});

const SearchPayloadSchema = FolderPayloadSchema.extend({
  query: z.string().min(1).max(200),
  includeBody: z.boolean().optional().default(false),
  limit: z.number().int().positive().max(200).optional().default(100),
});

const SenderMessagesPayloadSchema = AuthPayloadSchema.extend({
  sender: z.string().trim().toLowerCase().email().max(320),
  limit: z.number().int().positive().max(50).optional().default(50),
  cursor: z
    .object({
      beforeUid: z.number().int().positive(),
      uidValidity: z.string().min(1).max(64),
    })
    .strict()
    .optional(),
}).strict();

app.post("/api/search", requireKey, imapGate("interactive"), async (req, res) => {
  try {
    const payload = SearchPayloadSchema.parse(req.body);
    const messages = await searchMessages(
      payload.account as any,
      payload.password,
      payload.folder,
      payload.query,
      { includeBody: payload.includeBody, limit: payload.limit },
    );
    return res.json({ ok: true, messages });
  } catch (err: any) {
    console.error("[bridge] /api/search error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to search" });
  }
});

app.post("/api/sender-messages", requireKey, imapGate("background"), async (req, res) => {
  try {
    const payload = SenderMessagesPayloadSchema.parse(req.body);
    const page = await getSenderMessagesPage(
      payload.account as MailAccount,
      payload.password,
      payload.sender,
      payload.limit,
      payload.cursor
        ? {
            beforeUid: payload.cursor.beforeUid!,
            uidValidity: payload.cursor.uidValidity!,
          }
        : undefined,
    );
    return res.json({ ok: true, ...page });
  } catch {
    console.error("[bridge] /api/sender-messages failed");
    return res.status(500).json({ ok: false, error: "Sender history request failed" });
  }
});

app.post("/api/send", requireKey, async (req, res) => {
  try {
    const payload = SendPayloadSchema.parse(req.body);
    const result = await sendMessage(payload.account as any, payload.password, {
      from: {
        name: payload.account.display_name || payload.account.email_address,
        email: payload.account.email_address,
      },
      to: payload.to as any,
      cc: payload.cc as any,
      bcc: payload.bcc as any,
      subject: payload.subject,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
      bodyHtml: payload.bodyHtml,
      bodyText: payload.bodyText,
    });
    if ("error" in result) {
      return res.status(500).json({ ok: false, error: result.error });
    }
    return res.json({
      ok: true,
      messageId: result.messageId,
      sentCopySaved: result.sentCopySaved,
    });
  } catch (err: any) {
    console.error("[bridge] /api/send error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to send message" });
  }
});

// ---- Attachment upload pipeline (shared by send-multipart AND draft-save) ----
// Streaming to disk (see uploads.ts) keeps RSS flat under upload bursts.
// A dedicated concurrency gate then caps how many sends can be in flight so
// SMTP dial-out itself cannot blow up memory. Drafts REUSE the exact same
// multer instance / limits / disk-streaming pipeline so we never diverge
// from the send contract on file-size, count, or storage.
const SEND_MAX_TOTAL_BYTES = Number(process.env.SEND_MAX_TOTAL_BYTES || 25 * 1024 * 1024);
const SEND_MAX_FILES = Number(process.env.SEND_MAX_FILES || 10);
// Separate bounded resource classes: normal attachments (staged handles +
// server-source attachments) cap at 10, MIME inline/CID images cap at 20, and
// the absolute MIME file-part count caps at 30. Inline images never consume
// the user's normal-attachment quota and vice versa. Byte limits stay shared.
const MAX_NORMAL_ATTACHMENTS = 10;
const MAX_INLINE_IMAGES = 20;
const MAX_TOTAL_FILE_PARTS = 30;

const SEND_GLOBAL_MAX = Number(process.env.SEND_GLOBAL_MAX || 20);
const SEND_PER_ACCOUNT_MAX = Number(process.env.SEND_PER_ACCOUNT_MAX || 3);

const sendGates = createSendGates({
  globalMax: SEND_GLOBAL_MAX,
  perKeyMax: SEND_PER_ACCOUNT_MAX,
});
const directUploadGate = new TransferConcurrency(Number(process.env.MAIL_UPLOAD_CONCURRENCY || 8));

const sendUpload = multer({
  storage: uploadStorage,
  limits: {
    fileSize: SEND_MAX_TOTAL_BYTES,
    files: SEND_MAX_FILES,
    fields: 20,
    fieldSize: 5 * 1024 * 1024, // body HTML can be up to 5MB
  },
});

app.post("/api/attachment-upload-ticket", requireKey, (req, res) => {
  try {
    const payload = UploadTicketPayloadSchema.parse(req.body);
    if (payload.kind === "inline-image" && payload.size > 5 * 1024 * 1024) {
      return res.status(413).json({ ok: false, error: "ATTACHMENT_TOO_LARGE" });
    }
    const account = accountBinding(payload.account as MailAccount);
    const expiresAt = Date.now() + 60_000;
    const ticket = sealTransferTicket(BRIDGE_API_KEY, {
      purpose: "attachment-upload",
      account,
      exp: expiresAt,
      data: {
        filename: payload.filename,
        size: payload.size,
        mimeType: payload.mimeType,
        kind: payload.kind,
      },
    });
    const publicBase = publicBridgeBase(req);
    return res.json({
      ok: true,
      uploadUrl: `${publicBase}/api/direct/attachment-upload`,
      ticket,
      expiresAt,
    });
  } catch {
    return res.status(400).json({ ok: false, error: "INVALID_PAYLOAD" });
  }
});

app.post("/api/direct/attachment-upload", async (req, res) => {
  const handlerStartedAt = performance.now();
  const release = directUploadGate.tryAcquire();
  if (!release) return res.status(429).json({ ok: false, error: "UPLOAD_BUSY" });
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const ticket = openTransferTicket(BRIDGE_API_KEY, token, {
      purpose: "attachment-upload",
    });
    const data = ticket.data as Record<string, unknown>;
    if (
      typeof data.filename !== "string" ||
      typeof data.size !== "number" ||
      typeof data.mimeType !== "string" ||
      (data.kind !== "attachment" && data.kind !== "inline-image")
    ) {
      return res.status(400).json({ ok: false, error: "INVALID_TICKET" });
    }
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength && contentLength !== data.size) {
      return res.status(400).json({ ok: false, error: "UPLOAD_SIZE_MISMATCH" });
    }
    const stageStartedAt = performance.now();
    const staged = await stageAttachmentStream({
      secret: BRIDGE_API_KEY,
      account: ticket.account,
      filename: data.filename,
      mimeType: data.mimeType,
      kind: data.kind,
      declaredSize: data.size,
      stream: req,
    });
    const stageMs = performance.now() - stageStartedAt;
    const totalMs = performance.now() - handlerStartedAt;
    res.setHeader(
      "Server-Timing",
      `stage;dur=${stageMs.toFixed(1)}, total;dur=${totalMs.toFixed(1)}`,
    );
    res.setHeader("X-MailMaestro-Stage-Ms", stageMs.toFixed(1));
    console.info("[bridge] Direct upload complete", {
      bytes: staged.size,
      stageMs: Math.round(stageMs),
      totalMs: Math.round(totalMs),
    });
    return res.json({ ok: true, ...staged });
  } catch (error) {
    const code = error instanceof Error ? error.message : "UPLOAD_FAILED";
    const status = code.includes("TOO_LARGE") || code.includes("QUOTA") ? 413 : 400;
    return res.status(status).json({ ok: false, error: code });
  } finally {
    release();
  }
});

app.post("/api/send-v2", requireKey, async (req, res) => {
  const foregroundStartedAt = performance.now();
  let gateKey: string | null = null;
  let gateAcquired = false;
  let stagedAccount: string | null = null;
  let clientHandles: string[] = [];
  let sourceHandles: string[] = [];
  let sendSucceeded = false;
  try {
    const payload = SendV2PayloadSchema.parse(req.body);
    // Raw-payload fail-fast: both arrays are schema-capped individually (10
    // each), so a combined normal count above MAX_NORMAL_ATTACHMENTS must be
    // rejected before resolving handles or staging server sources — otherwise
    // an invalid payload would trigger avoidable IMAP/download/staging work.
    if (
      payload.attachmentHandles.length + payload.sourceAttachments.length >
      MAX_NORMAL_ATTACHMENTS
    ) {
      return res.status(413).json({ ok: false, error: "ATTACHMENTS_TOO_LARGE" });
    }
    const account = accountBinding(payload.account as MailAccount);
    stagedAccount = account;
    clientHandles = [
      ...payload.attachmentHandles,
      ...payload.stagedInlineImages.map(({ handle }) => handle),
    ];
    const handleResolveStartedAt = performance.now();
    const normal = await Promise.all(
      payload.attachmentHandles.map((handle) =>
        resolveStagedAttachment(BRIDGE_API_KEY, handle, account),
      ),
    );
    const inline = await Promise.all(
      payload.stagedInlineImages.map(async (item) => ({
        item,
        staged: await resolveStagedAttachment(BRIDGE_API_KEY, item.handle, account),
      })),
    );
    const handleResolveMs = performance.now() - handleResolveStartedAt;
    const sourceStageStartedAt = performance.now();
    const sourceAttachments = await stageServerAttachmentSources({
      secret: BRIDGE_API_KEY,
      account: payload.account as MailAccount,
      password: payload.password,
      sources: payload.sourceAttachments.map((source) => ({
        folderPath: source.folderPath,
        uid: source.uid,
        uidValidity: source.uidValidity,
        part: source.part,
        filename: source.filename,
        size: source.size,
        mimeType: source.mimeType,
      })),
      maxBytes: SEND_MAX_TOTAL_BYTES,
    });
    const sourceStageMs = performance.now() - sourceStageStartedAt;
    sourceHandles = sourceAttachments.map(({ staged }) => staged.handle);
    const attachmentValidationFailure = classifyAttachmentValidationFailure(normal, inline);
    if (attachmentValidationFailure) {
      console.warn("[bridge] send-v2 attachment validation failed", {
        code: attachmentValidationFailure,
      });
      return res.status(400).json({ ok: false, error: "ATTACHMENT_KIND_MISMATCH" });
    }
    const all = [...normal, ...inline.map(({ staged }) => staged)];
    all.push(...sourceAttachments.map(({ resolved }) => resolved));
    // Authoritative semantic counts: normal attachments arrive partly as
    // staged client handles and partly as server-source attachments, so the
    // normal 10-cap applies to the combined resolved set. Inline/CID images
    // get their own 20-cap; the absolute MIME file-part count caps at 30.
    // The shared decoded-byte budget stays unchanged.
    const normalParts = normal.length + sourceAttachments.length;
    const inlineParts = inline.length;
    if (
      normalParts > MAX_NORMAL_ATTACHMENTS ||
      inlineParts > MAX_INLINE_IMAGES ||
      normalParts + inlineParts > MAX_TOTAL_FILE_PARTS ||
      all.reduce((sum, item) => sum + item.size, 0) > SEND_MAX_TOTAL_BYTES
    ) {
      return res.status(413).json({ ok: false, error: "ATTACHMENTS_TOO_LARGE" });
    }
    gateKey = payload.account.email_address.toLowerCase();
    if (!sendGates.tryAcquire(gateKey)) {
      return res.status(429).json({ ok: false, error: "SEND_BUSY" });
    }
    gateAcquired = true;
    const attachments = await mapUploadedAttachments(
      all.map((item) => ({
        originalname: item.filename,
        path: item.path,
        mimetype: item.mimeType,
        size: item.size,
      })),
      payload.stagedInlineImages.map(({ uploadFilename, cid, contentType }) => ({
        uploadFilename,
        cid,
        contentType,
      })),
    );
    const result = await sendMessageFast(payload.account as MailAccount, payload.password, {
      from: {
        name: payload.account.display_name || payload.account.email_address,
        email: payload.account.email_address,
      },
      to: payload.to.map((item) => ({ name: item.name, email: item.email })),
      cc: payload.cc.map((item) => ({ name: item.name, email: item.email })),
      bcc: payload.bcc.map((item) => ({ name: item.name, email: item.email })),
      subject: payload.subject,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
      bodyHtml: payload.bodyHtml,
      bodyText: payload.bodyText,
      attachments,
    });
    if (!result.ok) return res.status(500).json(result);
    sendSucceeded = true;
    const foregroundTotalMs = performance.now() - foregroundStartedAt;
    res.setHeader(
      "Server-Timing",
      [
        `handleResolve;dur=${handleResolveMs.toFixed(1)}`,
        `sourceStage;dur=${sourceStageMs.toFixed(1)}`,
        `mimeSpool;dur=${result.timings.mimeSpoolMs.toFixed(1)}`,
        `smtp;dur=${result.timings.smtpMs.toFixed(1)}`,
        `foregroundTotal;dur=${foregroundTotalMs.toFixed(1)}`,
      ].join(", "),
    );
    return res.json(result);
  } catch (error) {
    const code =
      error instanceof z.ZodError
        ? "INVALID_PAYLOAD"
        : error instanceof Error
          ? error.message
          : "SEND_FAILED";
    return res.status(400).json({ ok: false, error: code });
  } finally {
    if (stagedAccount) {
      await cleanupSendStagedAttachments({
        secret: BRIDGE_API_KEY,
        account: stagedAccount,
        clientHandles,
        sourceHandles,
        sendSucceeded,
      }).catch(() => undefined);
    }
    if (gateAcquired && gateKey) sendGates.release(gateKey);
  }
});

app.post("/api/send-status", requireKey, (req, res) => {
  try {
    const payload = SendStatusPayloadSchema.parse(req.body);
    const status = postSendFinalizers.getStatus(
      sentCopyAccountKey(payload.account as MailAccount),
      payload.jobId,
    );
    if (!status) return res.status(404).json({ ok: false, error: "STATUS_NOT_FOUND" });
    return res.json({ ok: true, ...status });
  } catch (error) {
    const code = error instanceof z.ZodError ? "INVALID_PAYLOAD" : "STATUS_FAILED";
    return res.status(400).json({ ok: false, error: code });
  }
});

app.post("/api/draft-revision-reconcile", requireKey, imapGate("interactive"), async (req, res) => {
  try {
    const payload = DraftRevisionReconcilePayloadSchema.parse(req.body);
    const result = await reconcileDraftRevision(
      payload.account as MailAccount,
      payload.password,
      { draftId: payload.draftId, revisionId: payload.revisionId },
    );
    if ("error" in result) {
      const status =
        result.error === "RETRYABLE_DRAFT_IDENTITY_SEARCH"
          ? 503
          : result.error === "NO_DRAFTS_FOLDER"
            ? 422
            : 500;
      return res.status(status).json({ ok: false, error: result.error });
    }
    if (result.found) return res.json({ ok: true, ...result });
    return res.json({ ok: true, found: false });
  } catch (error) {
    return res.status(error instanceof z.ZodError ? 400 : 500).json({
      ok: false,
      error: error instanceof z.ZodError ? "INVALID_PAYLOAD" : "DRAFT_RECONCILIATION_FAILED",
    });
  }
});

app.post("/api/draft-save-v2", requireKey, imapGate("interactive"), async (req, res) => {
  let stagedAccount: string | null = null;
  let preservedSourceHandles: string[] = [];
  let preservedInlineSourceHandles: string[] = [];
  let saveSucceeded = false;
  const routeStartedAt = performance.now();
  let phaseStartedAt = routeStartedAt;
  const markRoutePhase = (phase: string, bytes = 0) => {
    const now = performance.now();
    if (TIMING_ENABLED) {
      console.log(
        `[draft-route-timing] phase=${phase} ms=${Math.round(now - phaseStartedAt)} bytes=${bytes}`,
      );
    }
    phaseStartedAt = now;
  };
  try {
    const diagnostics = (req.body as { diagnostics?: unknown } | undefined)?.diagnostics;
    if (diagnostics != null) {
      const trigger = DraftTriggerDiagnosticsSchema.parse(diagnostics);
      if (TIMING_ENABLED) {
        console.log(
          `[draft-trigger] reason=${trigger.reason} generation=${trigger.generation} inFlight=${trigger.inFlight} coalesced=${trigger.coalesced} dirty=${trigger.dirty} attachmentsChanged=${trigger.attachmentsChanged}`,
        );
      }
    }
    const payload = DraftSavePayloadSchema.parse(req.body);
    const contract = DraftV2AttachmentSchema.parse(req.body);
    // Raw-payload fail-fast: reject an impossible combined normal count before
    // resolving handles or staging server sources (see send-v2).
    if (
      contract.attachmentHandles.length + contract.sourceAttachments.length >
      MAX_NORMAL_ATTACHMENTS
    ) {
      return res.status(413).json({ ok: false, error: "ATTACHMENTS_TOO_LARGE" });
    }
    const account = accountBinding(payload.account as MailAccount);

    stagedAccount = account;

    // --- Staged-source reuse pass -------------------------------------
    // A kept draft attachment whose staged copy is still on disk is served
    // straight from disk: no IMAP download, no re-staging, and (when every
    // source is reusable) no draft-identity round-trip at all. A handle that
    // is missing, expired, foreign or of the wrong kind is simply ignored and
    // the attachment falls back to its IMAP descriptor — a dead handle can
    // never fail a draft save.
    const reuseStagedSource = async (
      handle: string | undefined,
      kind: "attachment" | "inline-image",
    ): Promise<{ handle: string; resolved: ResolvedStagedAttachment } | null> => {
      if (!handle) return null;
      try {
        const resolved = await resolveStagedAttachment(BRIDGE_API_KEY, handle, account);
        if (resolved.kind !== kind) return null;
        return { handle, resolved };
      } catch {
        return null;
      }
    };
    const reusedNormalSources = await Promise.all(
      contract.sourceAttachments.map((source) => reuseStagedSource(source.handle, "attachment")),
    );
    const reusedInlineSources = await Promise.all(
      contract.sourceInlineImages.map((source) =>
        reuseStagedSource(source.handle, "inline-image"),
      ),
    );
    markRoutePhase(
      "staged-source-reuse",
      [...reusedNormalSources, ...reusedInlineSources].reduce(
        (sum, item) => sum + (item?.resolved.size ?? 0),
        0,
      ),
    );

    let normalSourceInputs = contract.sourceAttachments
      .filter((_, index) => !reusedNormalSources[index])
      .map((source) => ({
        folderPath: source.folderPath,
        uid: source.uid,
        uidValidity: source.uidValidity,
        part: source.part,
        filename: source.filename,
        size: source.size,
        mimeType: source.mimeType,
      }));
    let inlineSourceInputs = contract.sourceInlineImages
      .filter((_, index) => !reusedInlineSources[index])
      .map((source) => ({
        folderPath: source.folderPath,
        uid: source.uid,
        uidValidity: source.uidValidity,
        part: source.part,
        filename: source.filename,
        size: source.size,
        mimeType: source.mimeType,
        uploadFilename: source.uploadFilename,
        cid: source.cid,
      }));
    if (normalSourceInputs.length > 0 || inlineSourceInputs.length > 0) {
      const reconciled = await reconcileDraftRevision(
        payload.account as MailAccount,
        payload.password,
        { draftId: payload.draftId, revisionId: payload.revisionId },
      );
      markRoutePhase("pre-source-revision-reconciliation");
      if ("error" in reconciled) {
        const status =
          reconciled.error === "RETRYABLE_DRAFT_IDENTITY_SEARCH"
            ? 503
            : reconciled.error === "NO_DRAFTS_FOLDER"
              ? 422
              : 500;
        return res.status(status).json(reconciled);
      }
      if (reconciled.found) {
        saveSucceeded = true;
        return res.json({
          ...reconciled,
          sourceAttachmentHandles: [],
          inlineSourceHandles: [],
        });
      }
      if ("canonicalRef" in reconciled && reconciled.canonicalRef) {
        const descriptorIsStale = [...normalSourceInputs, ...inlineSourceInputs].some(
          (source) =>
            source.folderPath !== reconciled.canonicalRef!.folderPath ||
            source.uid !== reconciled.canonicalRef!.uid ||
            source.uidValidity !== reconciled.canonicalRef!.uidValidity,
        );
        if (descriptorIsStale) {
          const rebound = await rebindServerSourcesToCanonicalDraft({
            account: payload.account as MailAccount,
            password: payload.password,
            canonicalRef: reconciled.canonicalRef,
            normal: normalSourceInputs,
            inline: inlineSourceInputs,
            draftTiming: true,
          });
          normalSourceInputs = rebound.normal;
          inlineSourceInputs = rebound.inline;
          markRoutePhase("canonical-source-rebind");
        }
      }
    }
    const resolvedNormal = await Promise.all(
      contract.attachmentHandles.map((handle) =>
        resolveStagedAttachment(BRIDGE_API_KEY, handle, account),
      ),
    );
    markRoutePhase(
      "staged-normal-resolution",
      resolvedNormal.reduce((sum, item) => sum + item.size, 0),
    );
    if (resolvedNormal.some((item) => item.kind !== "attachment")) {
      return res.status(400).json({ ok: false, error: "ATTACHMENT_KIND_MISMATCH" });
    }
    const resolvedInline = await Promise.all(
      contract.stagedInlineImages.map(async (item) => ({
        item,
        staged: await resolveStagedAttachment(BRIDGE_API_KEY, item.handle, account),
      })),
    );
    markRoutePhase(
      "staged-inline-resolution",
      resolvedInline.reduce((sum, item) => sum + item.staged.size, 0),
    );
    const freshInlineSources = await stageServerInlineSources({
      secret: BRIDGE_API_KEY,
      account: payload.account as MailAccount,
      password: payload.password,
      sources: inlineSourceInputs,
      maxBytes: SEND_MAX_TOTAL_BYTES,
      draftTiming: true,
    });
    // Only freshly staged copies are owned by this request; reused handles
    // belong to the client and must survive a failed save.
    preservedInlineSourceHandles = freshInlineSources.map(({ staged }) => staged.handle);
    markRoutePhase(
      "server-inline-source-staging",
      freshInlineSources.reduce((sum, item) => sum + item.resolved.size, 0),
    );
    const freshNormalSources = await stageDraftServerAttachmentSources({
      secret: BRIDGE_API_KEY,
      account: payload.account as MailAccount,
      password: payload.password,
      sources: normalSourceInputs,
      maxBytes: SEND_MAX_TOTAL_BYTES,
    });
    preservedSourceHandles = freshNormalSources.map(({ staged }) => staged.handle);
    markRoutePhase(
      "server-normal-source-staging",
      freshNormalSources.reduce((sum, item) => sum + item.resolved.size, 0),
    );
    // Re-interleave reused and freshly staged sources back into the exact
    // request order so the returned handle arrays stay index-aligned with the
    // client's attachment ids.
    const mergeSources = (
      reused: ReadonlyArray<{ handle: string; resolved: ResolvedStagedAttachment } | null>,
      fresh: ReadonlyArray<{ staged: { handle: string }; resolved: ResolvedStagedAttachment }>,
    ): Array<{ handle: string; resolved: ResolvedStagedAttachment }> => {
      let next = 0;
      return reused.map((item) => {
        if (item) return item;
        const staged = fresh[next++]!;
        return { handle: staged.staged.handle, resolved: staged.resolved };
      });
    };
    const preserved = mergeSources(reusedNormalSources, freshNormalSources);
    const preservedInlineSources = mergeSources(reusedInlineSources, freshInlineSources);

    const all = [
      ...resolvedNormal,
      ...preserved.map(({ resolved }) => resolved),
      ...resolvedInline.map(({ staged }) => staged),
      ...preservedInlineSources.map(({ resolved }) => resolved),
    ];
    // Same authoritative semantic counts as send-v2: normal 10-cap covers
    // staged client handles + server-source attachments combined, inline/CID
    // images cap at 20, absolute file parts cap at 30, shared bytes unchanged.
    const normalParts = resolvedNormal.length + preserved.length;
    const inlineParts = resolvedInline.length + preservedInlineSources.length;
    if (
      normalParts > MAX_NORMAL_ATTACHMENTS ||
      inlineParts > MAX_INLINE_IMAGES ||
      normalParts + inlineParts > MAX_TOTAL_FILE_PARTS ||
      all.reduce((sum, item) => sum + item.size, 0) > SEND_MAX_TOTAL_BYTES
    ) {
      return res.status(413).json({ ok: false, error: "ATTACHMENTS_TOO_LARGE" });
    }
    const attachments = await mapUploadedAttachments(
      all.map((item) => ({
        originalname: item.filename,
        path: item.path,
        mimetype: item.mimeType,
        size: item.size,
      })),
      [
        ...contract.stagedInlineImages.map(({ uploadFilename, cid, contentType }) => ({
          uploadFilename,
          cid,
          contentType,
        })),
        ...contract.sourceInlineImages.map(({ uploadFilename, cid, mimeType }) => ({
          uploadFilename,
          cid,
          contentType: mimeType,
        })),
      ],
    );
    markRoutePhase(
      "mime-attachment-mapping",
      all.reduce((sum, item) => sum + item.size, 0),
    );
    if (TIMING_ENABLED) {
      console.log(
        `[draft-route-timing] phase=total-before-save-draft ms=${Math.round(performance.now() - routeStartedAt)} bytes=${all.reduce((sum, item) => sum + item.size, 0)}`,
      );
    }
    const result = await saveDraft(payload.account as MailAccount, payload.password, {
      ...payload,
      attachments,
    });
    if (result.ok === false) {
      const status =
        result.error === "NO_DRAFTS_FOLDER"
          ? 422
          : result.error === "RETRYABLE_DRAFT_IDENTITY_SEARCH"
            ? 503
            : result.error === "SAFE_DRAFT_REPLACE_UNSUPPORTED"
              ? 409
              : 500;
      return res.status(status).json(result);
    }
    saveSucceeded = true;
    return res.json({
      ...result,
      sourceAttachmentHandles: preserved.map(({ handle }) => handle),
      inlineSourceHandles: preservedInlineSources.map(({ handle }) => handle),

    });
  } catch (error) {
    const code =
      error instanceof z.ZodError
        ? "INVALID_PAYLOAD"
        : error instanceof Error
          ? error.message
          : "IMAP_ERROR";
    return res.status(400).json({ ok: false, error: code });
  } finally {
    // On failure, fresh server-source attachments staged for this draft save
    // are owned by no one (the client only learns the returned handles when
    // the save succeeds). Release them so they cannot leak forever. On success
    // the client keeps them for reuse by the next save/send.
    const abandonedSourceHandles = draftSourceHandlesToRelease({
      normal: preservedSourceHandles,
      inline: preservedInlineSourceHandles,
      saveSucceeded,
    });
    if (stagedAccount && abandonedSourceHandles.length > 0 && !saveSucceeded) {
      await releaseStagedAttachments(BRIDGE_API_KEY, abandonedSourceHandles, stagedAccount).catch(
        () => undefined,
      );
    }
  }
});

const StagedReleasePayloadSchema = z.object({
  account: AccountSchema,
  handles: z.array(z.string().min(20).max(32 * 1024)).min(1).max(64),
});

app.post("/api/staged-release", requireKey, async (req, res) => {
  try {
    const payload = StagedReleasePayloadSchema.parse(req.body);
    const account = accountBinding(payload.account as MailAccount);
    // Validate every handle before releasing any so a tampered, foreign-account
    // or expired payload cannot cause a partial release.
    const uniqueHandles = [...new Set(payload.handles)];
    for (const handle of uniqueHandles) {
      if (!validateStagedHandle(BRIDGE_API_KEY, handle, account)) {
        return res.status(400).json({ ok: false, error: "INVALID_STAGE_HANDLE" });
      }
    }
    const released = await releaseStagedAttachments(BRIDGE_API_KEY, uniqueHandles, account);
    return res.json({ ok: true, released });
  } catch (error) {
    const code = error instanceof z.ZodError ? "INVALID_PAYLOAD" : "RELEASE_FAILED";
    return res.status(400).json({ ok: false, error: code });
  }
});

// ---- Drafts (MAILMAESTRO_DRAFT_APPEND_R1) ----
// APPEND-then-delete-old against the resolved Drafts folder. Idempotent via
// the X-MailMaestro-Draft-ID header (IMAP is the source of truth — no
// process-local memory). Never returns subject/body/recipients in errors.
// Draft saves flow through /api/draft-save-v2 (staged handles); the legacy
// multipart /api/draft-save route is removed.
app.post("/api/draft-delete", requireKey, imapGate("interactive"), async (req, res) => {
  try {
    const payload = DraftDeletePayloadSchema.parse(req.body);
    const result = await deleteDraft(payload.account as any, payload.password, payload);
    if (result.ok === false) {
      const err = result.error;
      // Surface the coarse (PII-safe) code when timing is enabled — this path
      // was previously silent, which hid the exact delete failure.
      if (TIMING_ENABLED) {
        console.log(`[draft-timing] op=delete status=error code=${err}`);
      }
      const status = err === "UIDPLUS_UNSUPPORTED" ? 409 : 500;
      return res.status(status).json({ ok: false, error: err });
    }

    return res.json({
      ok: true,
      draftId: result.draftId,
      folderPath: result.folderPath,
      deleted: result.deleted,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ ok: false, error: "INVALID_PAYLOAD" });
    }
    console.error("[bridge] /api/draft-delete error:", err?.code || "unknown");
    return res.status(500).json({ ok: false, error: "IMAP_ERROR" });
  }
});

// ---- Send with attachments (multipart/form-data, streamed to disk) ----

app.post(
  "/api/send-multipart",
  requireKey,
  sendUpload.array("attachments", SEND_MAX_FILES),
  async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    let gateKey: string | null = null;
    let gateAcquired = false;
    // Belt-and-braces cleanup: if the client aborts before we finish, drop
    // any files we've already written. Never runs after a normal end because
    // the finally block will have already unlinked them.
    const abortHandler = () => {
      if (!res.writableEnded) {
        cleanupFiles(files).catch(() => {});
        if (gateAcquired && gateKey) {
          sendGates.release(gateKey);
          gateAcquired = false;
        }
      }
    };
    req.on("aborted", abortHandler);
    res.on("close", abortHandler);
    try {
      const raw = req.body?.payload;
      if (typeof raw !== "string") {
        return res.status(400).json({ ok: false, error: "Missing payload field" });
      }
      const parsed = JSON.parse(raw);
      const payload = SendPayloadSchema.parse(parsed);

      const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
      if (totalBytes > SEND_MAX_TOTAL_BYTES) {
        return res.status(413).json({ ok: false, error: "المرفقات تتجاوز الحد المسموح" });
      }

      // Acquire concurrency slot AFTER validation so bad requests don't burn
      // capacity. Reject cleanly if the bridge is saturated.
      gateKey = payload.account.email_address.toLowerCase();
      if (!sendGates.tryAcquire(gateKey)) {
        return res
          .status(429)
          .json({ ok: false, error: "SEND_BUSY", message: "الخادم مشغول، حاول بعد قليل" });
      }
      gateAcquired = true;

      // Nodemailer accepts `path` — it streams from disk, so we never
      // materialise the full attachment payload in Node heap.
      const attachments = await mapUploadedAttachments(files, payload.inlineImages);

      const result = await sendMessage(payload.account as any, payload.password, {
        from: {
          name: payload.account.display_name || payload.account.email_address,
          email: payload.account.email_address,
        },
        to: payload.to as any,
        cc: payload.cc as any,
        bcc: payload.bcc as any,
        subject: payload.subject,
        inReplyTo: payload.inReplyTo,
        references: payload.references,
        bodyHtml: payload.bodyHtml,
        bodyText: payload.bodyText,
        attachments,
      });
      if ("error" in result) {
        return res.status(500).json({ ok: false, error: result.error });
      }
      return res.json({
        ok: true,
        messageId: result.messageId,
        sentCopySaved: result.sentCopySaved,
      });
    } catch (err: any) {
      if (err?.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ ok: false, error: "ملف يتجاوز الحد المسموح (25MB)" });
      }
      if (err?.code === "LIMIT_FILE_COUNT") {
        return res.status(413).json({ ok: false, error: "عدد الملفات يتجاوز الحد (10)" });
      }
      // Log only the coarse error code / message, never the payload.
      console.error("[bridge] /api/send-multipart error:", err?.code || err?.message || "unknown");
      return res.status(500).json({ ok: false, error: "Failed to send message" });
    } finally {
      req.off("aborted", abortHandler);
      res.off("close", abortHandler);
      if (gateAcquired && gateKey) sendGates.release(gateKey);
      // Always drop temp files: success, SMTP failure, validation error,
      // or gate rejection all funnel through here.
      await cleanupFiles(files).catch(() => {});
    }
  },
);

// ---- Attachment download (streamed) ----
const ATTACHMENT_MAX_BYTES = Number(process.env.ATTACHMENT_MAX_BYTES || 50 * 1024 * 1024);
const DOWNLOAD_CHUNK_BYTES = parseDownloadChunkBytes(process.env.MAIL_DOWNLOAD_CHUNK_BYTES);
const AttachmentPayloadSchema = MessagePayloadSchema.extend({
  part: z.string().min(1).max(50),
});

// Draft-only import capability. It deliberately accepts the physical mailbox
// identity captured when the provider Draft was opened: folderPath +
// UIDVALIDITY + UID + MIME part. No filename/MIME rebinding is performed here;
// a stale descriptor fails closed rather than selecting a same-named sibling.
const DraftSourceAttachmentPayloadSchema = AuthPayloadSchema.extend({
  folderPath: z.string().min(1).max(500),
  uid: z.number().int().positive(),
  uidValidity: z.string().min(1).max(64),
  part: z.string().regex(/^\d+(?:\.\d+)*$/),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  size: z.number().int().min(0).max(25 * 1024 * 1024),
  kind: z.enum(["attachment", "inline-image"]),
});

const downloadGates = createSendGates({
  globalMax: Number(process.env.MAIL_DOWNLOAD_GLOBAL_MAX || 16),
  perKeyMax: Number(process.env.MAIL_DOWNLOAD_ACCOUNT_MAX || 1),
});

app.post("/api/attachment-download-ticket", requireKey, (req, res) => {
  try {
    const payload = DownloadTicketPayloadSchema.parse(req.body);
    const expiresAt = Date.now() + 60_000;
    const ticket = sealTransferTicket(BRIDGE_API_KEY, {
      purpose: "attachment-download",
      account: accountBinding(payload.account as MailAccount),
      exp: expiresAt,
      data: payload,
    });
    const publicBase = publicBridgeBase(req);
    return res.json({
      ok: true,
      downloadUrl: `${publicBase}/api/direct/attachment-download?t=${encodeURIComponent(ticket)}`,
      expiresAt,
    });
  } catch {
    return res.status(400).json({ ok: false, error: "INVALID_PAYLOAD" });
  }
});

app.get("/api/direct/attachment-download", async (req, res) => {
  const requestStartedAt = performance.now();
  let gateKey = "";
  let acquired = false;
  let capabilityValidated = false;
  let transferAccount: MailAccount | null = null;
  try {
    const ticket = openTransferTicket(BRIDGE_API_KEY, String(req.query.t || ""), {
      purpose: "attachment-download",
    });
    const payload = DownloadCapabilityDataSchema.parse(ticket.data);
    transferAccount = payload.account as MailAccount;
    gateKey = ticket.account;
    if (accountBinding(payload.account as MailAccount) !== gateKey) {
      return res.status(403).end("Invalid capability");
    }
    capabilityValidated = true;
    if (payload.size > ATTACHMENT_MAX_BYTES) {
      return res.status(413).end("Attachment too large");
    }
    if (!downloadGates.tryAcquire(gateKey)) {
      return res.status(429).end("Transfer busy");
    }
    acquired = true;
    const mailboxes = await getMailboxesCached(
      payload.account as MailAccount,
      payload.password,
      "transfer",
    );
    const folderPath = resolveFolderPath(mailboxes, payload.folder);
    if (!folderPath) return res.status(404).end("Attachment not found");

    await withAccountMailbox(
      payload.account as MailAccount,
      payload.password,
      folderPath,
      async (client) => {
        const download = await client.download(payload.uid.toString(), payload.part, {
          uid: true,
          maxBytes: ATTACHMENT_MAX_BYTES,
          chunkSize: DOWNLOAD_CHUNK_BYTES,
        });
        const openMs = performance.now() - requestStartedAt;
        if (!download?.content) {
          res.status(404).end("Attachment not found");
          return;
        }
        const meta = download.meta as {
          contentType?: string;
          filename?: string;
          expectedSize?: number;
        };
        const expectedSize = Number(meta.expectedSize ?? payload.size);
        if (Number.isFinite(expectedSize) && expectedSize > ATTACHMENT_MAX_BYTES) {
          download.content.destroy();
          dropAccountConnection(payload.account as MailAccount, "transfer");
          res.status(413).end("Attachment too large");
          return;
        }
        const mimeType = String(meta.contentType || payload.mimeType || "application/octet-stream")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        const filename = sanitizeAttachmentFilename(meta.filename || payload.filename);
        res.setHeader("Content-Type", mimeType);
        res.setHeader(
          "Content-Disposition",
          attachmentContentDisposition(filename, mimeType, payload.mode),
        );
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-MailMaestro-Download-Chunk-Bytes", String(DOWNLOAD_CHUNK_BYTES));
        const byteCounter = new DownloadByteCounter(requestStartedAt);
        let completed = false;
        let aborted = false;
        let logged = false;
        const logDownload = (status: "complete" | "aborted" | "failed") => {
          if (logged) return;
          logged = true;
          const fields = {
            bytes: byteCounter.bytes,
            chunkBytes: DOWNLOAD_CHUNK_BYTES,
            openMs: Math.round(openMs),
            firstByteMs:
              byteCounter.firstByteMs === null ? null : Math.round(byteCounter.firstByteMs),
            totalMs: Math.round(performance.now() - requestStartedAt),
            completed,
            aborted,
          };
          if (status === "failed") console.error("[bridge] Direct download failed", fields);
          else console.info(`[bridge] Direct download ${status}`, fields);
        };
        const abort = () => {
          if (completed || res.writableEnded) return;
          aborted = true;
          download.content.destroy();
          dropAccountConnection(payload.account as MailAccount, "transfer");
          logDownload("aborted");
        };
        res.once("close", abort);
        try {
          await pipeline(download.content, byteCounter, res);
          completed = true;
          logDownload("complete");
        } catch (error) {
          logDownload(aborted ? "aborted" : "failed");
          throw error;
        } finally {
          res.off("close", abort);
        }
      },
      "transfer",
    );
  } catch (error) {
    if (acquired && transferAccount && !res.writableEnded) {
      dropAccountConnection(transferAccount, "transfer");
    }
    if (!res.headersSent) {
      const code = error instanceof z.ZodError ? 400 : capabilityValidated ? 500 : 401;
      res
        .status(code)
        .end(
          code === 401
            ? "Invalid capability"
            : code === 400
              ? "Invalid request"
              : "Transfer failed",
        );
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    if (acquired) downloadGates.release(gateKey);
  }
});

app.post("/api/attachment", requireKey, imapGate("transfer"), async (req, res) => {
  try {
    const payload = AttachmentPayloadSchema.parse(req.body);
    const result = await downloadAttachment(
      payload.account as any,
      payload.password,
      payload.folder,
      payload.uid,
      payload.part,
      ATTACHMENT_MAX_BYTES,
    );
    if (!result) {
      return res.status(404).json({ ok: false, error: "Attachment not found" });
    }
    const { meta, content, cleanup } = result;
    const mimeType = (meta.contentType || "application/octet-stream").toLowerCase();
    const filename = sanitizeAttachmentFilename(meta.filename);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", attachmentContentDisposition(filename, mimeType));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    if (typeof meta.expectedSize === "number" && meta.expectedSize > 0) {
      res.setHeader("Content-Length", String(meta.expectedSize));
    }
    // Cancel IMAP read if client disconnects early.
    res.on("close", () => {
      if (!res.writableEnded) {
        try {
          content.destroy();
        } catch {
          // stream may already be closed; nothing to do.
        }
        cleanup().catch(() => {});
      }
    });
    content.on("error", (err) => {
      console.error("[bridge] attachment stream error:", err);
      if (!res.headersSent) res.status(500).end("Stream error");
      else res.end();
      cleanup().catch(() => {});
    });
    content.pipe(res);
  } catch (err: any) {
    console.error("[bridge] /api/attachment error:", err);
    if (!res.headersSent) {
      return res
        .status(500)
        .json({ ok: false, error: err?.message || "Failed to download attachment" });
    }
    res.end();
  }
});

/**
 * Import bytes for a metadata-only external provider Draft attachment.
 * This endpoint is used only by the server-side Working Draft importer. The
 * descriptor is an exact physical source identity, so it cannot fall back to
 * filename or MIME matching when another attachment happens to look alike.
 */
app.post("/api/draft-source-attachment", requireKey, imapGate("transfer"), async (req, res) => {
  let account: MailAccount | null = null;
  try {
    const payload = DraftSourceAttachmentPayloadSchema.parse(req.body);
    account = payload.account as MailAccount;
    const mailboxes = await getMailboxesCached(account, payload.password, "transfer");
    if (!mailboxes.some((mailbox) => mailbox.path === payload.folderPath)) {
      return res.status(404).json({ ok: false, error: "SOURCE_MAILBOX_MISMATCH" });
    }
    await withAccountMailbox(
      account,
      payload.password,
      payload.folderPath,
      async (client) => {
        const currentUidValidity = String(
          client.mailbox && typeof client.mailbox === "object" ? client.mailbox.uidValidity : "",
        );
        if (!currentUidValidity || currentUidValidity !== payload.uidValidity) {
          return res.status(409).json({ ok: false, error: "SOURCE_UIDVALIDITY_MISMATCH" });
        }
        const download = await client.download(payload.uid.toString(), payload.part, {
          uid: true,
          // Observe one byte beyond the durable Draft limit so the stream is
          // rejected rather than silently truncated at exactly the boundary.
          maxBytes: 25 * 1024 * 1024 + 1,
        });
        if (!download?.content) return res.status(404).json({ ok: false, error: "SOURCE_ATTACHMENT_MISSING" });
        const meta = download.meta as {
          contentType?: string;
          filename?: string;
          expectedSize?: number;
        };
        const expectedSize = Number(meta.expectedSize);
        if (Number.isFinite(expectedSize) && (expectedSize < 0 || expectedSize > 25 * 1024 * 1024)) {
          download.content.destroy();
          return res.status(413).json({ ok: false, error: "SOURCE_ATTACHMENT_TOO_LARGE" });
        }
        const mimeType = String(meta.contentType || payload.mimeType || "application/octet-stream")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        res.setHeader("Content-Type", mimeType);
        res.setHeader("Content-Disposition", attachmentContentDisposition(sanitizeAttachmentFilename(meta.filename || payload.filename), mimeType));
        if (Number.isFinite(expectedSize) && expectedSize > 0) {
          res.setHeader("Content-Length", String(expectedSize));
        }
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "private, no-store");
        let completed = false;
        const abort = () => {
          if (!completed && !res.writableEnded) {
            download.content.destroy();
            dropAccountConnection(account!, "transfer");
          }
        };
        res.once("close", abort);
        try {
          await pipeline(download.content, res);
          completed = true;
        } finally {
          res.off("close", abort);
        }
      },
      "transfer",
    );
  } catch (error) {
    if (account) dropAccountConnection(account, "transfer");
    if (!res.headersSent) {
      return res.status(error instanceof z.ZodError ? 400 : 500).json({
        ok: false,
        error: error instanceof z.ZodError ? "INVALID_PAYLOAD" : "SOURCE_ATTACHMENT_IMPORT_FAILED",
      });
    }
    if (!res.writableEnded) res.end();
  }
});

// ---- Sync endpoints (metadata-only, no DB writes) ----

app.post("/api/sync/initial", requireKey, imapGate("background"), async (req, res) => {
  try {
    const p = InitialSyncSchema.parse(req.body);
    const result = await runInitialSync(p.account as MailAccount, p.password, {
      folderPath: p.folderPath,
      limit: p.limit,
      countExcludeDeleted: p.countExcludeDeleted,
    });
    return res.json(result);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ ok: false, error: "INVALID_PAYLOAD", issues: err.issues });
    }
    const safe = safeError(err);
    console.error("[bridge] /api/sync/initial error:", safe.code);
    return res.status(500).json({ ok: false, error: safe.code, message: safe.message });
  }
});

app.post("/api/sync/incremental", requireKey, imapGate("background"), async (req, res) => {
  try {
    const p = IncrementalSyncSchema.parse(req.body);
    const result = await runIncrementalSync(p.account as MailAccount, p.password, {
      folderPath: p.folderPath,
      expectedUidValidity: p.expectedUidValidity,
      sinceUid: p.sinceUid,
      sinceModseq: p.sinceModseq,
      flagsFromUid: p.flagsFromUid,
      flagsToUid: p.flagsToUid,
      limit: p.limit,
      countExcludeDeleted: p.countExcludeDeleted,
    });
    return res.json(result);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ ok: false, error: "INVALID_PAYLOAD", issues: err.issues });
    }
    const safe = safeError(err);
    console.error("[bridge] /api/sync/incremental error:", safe.code);
    return res.status(500).json({ ok: false, error: safe.code, message: safe.message });
  }
});

app.post("/api/sync/reconcile", requireKey, imapGate("background"), async (req, res) => {
  try {
    const p = ReconcileSyncSchema.parse(req.body);
    const result = await runReconcileSync(p.account as MailAccount, p.password, {
      folderPath: p.folderPath,
      expectedUidValidity: p.expectedUidValidity,
      fromUid: p.fromUid,
      toUid: p.toUid,
      countExcludeDeleted: p.countExcludeDeleted,
    });
    return res.json(result);
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ ok: false, error: "INVALID_PAYLOAD", issues: err.issues });
    }
    const safe = safeError(err);
    console.error("[bridge] /api/sync/reconcile error:", safe.code);
    return res.status(500).json({ ok: false, error: safe.code, message: safe.message });
  }
});

const HOST = process.env.HOST || "127.0.0.1";

// Close the reusable per-account IMAP connections cleanly on shutdown.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    closeAllImapConnections()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

async function startServer() {
  // Fail-closed accounting barrier: reconcile in-memory staged-attachment
  // counters against disk BEFORE accepting traffic so quota decisions are
  // exact from the very first request (this also accounts for any .bin files
  // left behind by a previous run instead of assuming the counters start at 0).
  try {
    await cleanupStagedAttachments();
  } catch (error) {
    console.error("[bridge] failed to initialize staged-attachment accounting:", error);
    process.exit(1);
  }
  app.listen(PORT, HOST, () => {
    console.log(`[bridge] MailMaestro Bridge running on ${HOST}:${PORT}`);
    // Best-effort sweep of stale uploads from a previous crashed run.
    startupCleanup()
      .then((n) => n > 0 && console.log(`[bridge] cleaned ${n} stale upload(s)`))
      .catch(() => {});
    cleanupStaleMimeSpools()
      .then((n) => n > 0 && console.log(`[bridge] cleaned ${n} stale MIME spool(s)`))
      .catch(() => {});
    setInterval(() => cleanupStagedAttachments().catch(() => {}), 15 * 60_000).unref();
  });
}

void startServer();
