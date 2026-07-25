import "dotenv/config";
import express from "express";
import cors from "cors";
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

app.post("/api/messages", requireKey, async (req, res) => {
  try {
    const payload = FolderPayloadSchema.parse(req.body);
    const messages = await getMessages(payload.account as any, payload.password, payload.folder, {
      limit: req.body.limit ?? 50,
      offset: req.body.offset ?? 0,
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[bridge] MailMaestro Bridge running on port ${PORT}`);
});
