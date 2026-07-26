import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";

import { z } from "zod";
import {
  verifyCredentials,
  getFolderCounts,
  getMessages,
  getMessageBody,
  markRead,
  starMessage,
  moveMessage,
  deleteMessage,
  searchMessages,
  downloadAttachment,
} from "./imap.js";
import { sendMessage } from "./smtp.js";
import type { MailAccount, MailFolder } from "./types.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || "";

if (!BRIDGE_API_KEY) {
  console.warn("[bridge] Warning: BRIDGE_API_KEY is not set. Server will reject all requests.");
}

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

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
  to: z.array(
    z.object({ name: z.string(), email: z.string().email() }),
  ),
  cc: z.array(z.object({ name: z.string(), email: z.string().email() })).optional().default([]),
  bcc: z.array(z.object({ name: z.string(), email: z.string().email() })).optional().default([]),
  subject: z.string().min(1),
  bodyHtml: z.string().optional(),
  bodyText: z.string().optional(),
});

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

// --- Routes ---
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/api/verify", requireKey, async (req, res) => {
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

app.post("/api/folders", requireKey, async (req, res) => {
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

app.post("/api/messages", requireKey, async (req, res) => {
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

app.post("/api/message", requireKey, async (req, res) => {
  try {
    const payload = MessagePayloadSchema.parse(req.body);
    const message = await getMessageBody(payload.account as any, payload.password, payload.folder, payload.uid);
    if (!message) {
      return res.status(404).json({ ok: false, error: "Message not found" });
    }
    return res.json({ ok: true, message });
  } catch (err: any) {
    console.error("[bridge] /api/message error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to fetch message" });
  }
});

app.post("/api/mark-read", requireKey, async (req, res) => {
  try {
    const payload = MarkReadPayloadSchema.parse(req.body);
    await markRead(payload.account as any, payload.password, payload.folder, payload.uid, payload.read);
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("[bridge] /api/mark-read error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to update message" });
  }
});

app.post("/api/star", requireKey, async (req, res) => {
  try {
    const payload = StarPayloadSchema.parse(req.body);
    await starMessage(payload.account as any, payload.password, payload.folder, payload.uid, payload.starred);
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("[bridge] /api/star error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to update message" });
  }
});

app.post("/api/move", requireKey, async (req, res) => {
  try {
    const payload = MovePayloadSchema.parse(req.body);
    await moveMessage(payload.account as any, payload.password, payload.folder, payload.uid, payload.toFolder);
    return res.json({ ok: true });
  } catch (err: any) {
    console.error("[bridge] /api/move error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to move message" });
  }
});

app.post("/api/delete", requireKey, async (req, res) => {
  try {
    const payload = MessagePayloadSchema.parse(req.body);
    await deleteMessage(payload.account as any, payload.password, payload.folder, payload.uid);
    return res.json({ ok: true });
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

app.post("/api/search", requireKey, async (req, res) => {
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

app.post("/api/send", requireKey, async (req, res) => {
  try {
    const payload = SendPayloadSchema.parse(req.body);
    const result = await sendMessage(payload.account as any, payload.password, {
      from: { name: payload.account.display_name || payload.account.email_address, email: payload.account.email_address },
      to: payload.to as any,
      cc: payload.cc as any,
      bcc: payload.bcc as any,
      subject: payload.subject,
      bodyHtml: payload.bodyHtml,
      bodyText: payload.bodyText,
    });
    if (!result.ok && "error" in result) {
      return res.status(500).json({ ok: false, error: result.error });
    }
    return res.json({ ok: true, messageId: result.messageId });
  } catch (err: any) {
    console.error("[bridge] /api/send error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Failed to send message" });
  }
});

// ---- Send with attachments (multipart/form-data, streamed via multer) ----
const SEND_MAX_TOTAL_BYTES = Number(process.env.SEND_MAX_TOTAL_BYTES || 25 * 1024 * 1024);
const SEND_MAX_FILES = Number(process.env.SEND_MAX_FILES || 10);
const sendUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: SEND_MAX_TOTAL_BYTES,
    files: SEND_MAX_FILES,
    fields: 20,
    fieldSize: 5 * 1024 * 1024, // body HTML can be up to 5MB
  },
});

app.post(
  "/api/send-multipart",
  requireKey,
  sendUpload.array("attachments", SEND_MAX_FILES),
  async (req, res) => {
    try {
      const raw = req.body?.payload;
      if (typeof raw !== "string") {
        return res.status(400).json({ ok: false, error: "Missing payload field" });
      }
      const parsed = JSON.parse(raw);
      const payload = SendPayloadSchema.parse(parsed);

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
      if (totalBytes > SEND_MAX_TOTAL_BYTES) {
        return res.status(413).json({ ok: false, error: "المرفقات تتجاوز الحد المسموح" });
      }

      const attachments = files.map((f) => ({
        filename: f.originalname,
        content: f.buffer,
        contentType: f.mimetype,
      }));

      const result = await sendMessage(payload.account as any, payload.password, {
        from: {
          name: payload.account.display_name || payload.account.email_address,
          email: payload.account.email_address,
        },
        to: payload.to as any,
        cc: payload.cc as any,
        bcc: payload.bcc as any,
        subject: payload.subject,
        bodyHtml: payload.bodyHtml,
        bodyText: payload.bodyText,
        attachments,
      });
      if (!result.ok && "error" in result) {
        return res.status(500).json({ ok: false, error: result.error });
      }
      return res.json({ ok: true, messageId: result.messageId });
    } catch (err: any) {
      if (err?.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ ok: false, error: "ملف يتجاوز الحد المسموح (25MB)" });
      }
      if (err?.code === "LIMIT_FILE_COUNT") {
        return res.status(413).json({ ok: false, error: "عدد الملفات يتجاوز الحد (10)" });
      }
      console.error("[bridge] /api/send-multipart error:", err);
      return res.status(500).json({ ok: false, error: err?.message || "Failed to send message" });
    }
  },
);

// ---- Attachment download (streamed) ----
const ATTACHMENT_MAX_BYTES = Number(process.env.ATTACHMENT_MAX_BYTES || 50 * 1024 * 1024);
const INLINE_MIME_ALLOWLIST = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

function sanitizeFilename(name: string | undefined | null): string {
  if (!name) return "attachment";
  // Strip path separators, control chars, CR/LF (header injection).
  const cleaned = name
    .replace(/[\r\n]/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  return cleaned.slice(0, 200) || "attachment";
}

function contentDispositionHeader(filename: string, mimeType: string): string {
  const disposition = INLINE_MIME_ALLOWLIST.has(mimeType.toLowerCase()) ? "inline" : "attachment";
  const asciiSafe = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // RFC 5987 encoding for the real UTF-8 filename (Arabic names).
  const encoded = encodeURIComponent(filename);
  return `${disposition}; filename="${asciiSafe}"; filename*=UTF-8''${encoded}`;
}

const AttachmentPayloadSchema = MessagePayloadSchema.extend({
  part: z.string().min(1).max(50),
});

app.post("/api/attachment", requireKey, async (req, res) => {
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
    const filename = sanitizeFilename(meta.filename);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", contentDispositionHeader(filename, mimeType));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    if (typeof meta.expectedSize === "number" && meta.expectedSize > 0) {
      res.setHeader("Content-Length", String(meta.expectedSize));
    }
    // Cancel IMAP read if client disconnects early.
    res.on("close", () => {
      if (!res.writableEnded) {
        try { content.destroy(); } catch {}
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
      return res.status(500).json({ ok: false, error: err?.message || "Failed to download attachment" });
    }
    res.end();
  }
});
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`[bridge] MailMaestro Bridge running on ${HOST}:${PORT}`);
});
