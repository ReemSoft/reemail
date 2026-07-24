import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { MailFolder, FolderCount, MailMessage } from "@/lib/mail-types";
import type { MailSessionAccount } from "@/lib/mail-session";

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

const AccountSchema = z.object({
  id: z.string().min(1),
  company_id: z.string().min(1),
  email_address: z.string().email(),
  display_name: z.string().nullable().optional(),
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

const FolderPayloadSchema = AuthPayloadSchema.extend({
  folder: FolderSchema,
  limit: z.number().int().nonnegative().optional().default(50),
  offset: z.number().int().nonnegative().optional().default(0),
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

const AddressSchema = z.object({
  name: z.string(),
  email: z.string().email(),
});

const SendPayloadSchema = AuthPayloadSchema.extend({
  to: z.array(AddressSchema).min(1),
  cc: z.array(AddressSchema).optional().default([]),
  bcc: z.array(AddressSchema).optional().default([]),
  subject: z.string().min(1),
  bodyHtml: z.string().optional(),
  bodyText: z.string().optional(),
});

function bridgeConfigured() {
  return Boolean(process.env.MAIL_BRIDGE_URL && process.env.MAIL_BRIDGE_SECRET);
}

async function bridgePost(path: string, payload: unknown) {
  const url = process.env.MAIL_BRIDGE_URL;
  const key = process.env.MAIL_BRIDGE_SECRET;
  if (!url || !key) {
    return { ok: false, unavailable: true, error: "لم يتم ربط خادم البريد بعد" };
  }

  try {
    const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Key": key,
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({ ok: false, error: "Bridge error" }));
    if (!res.ok || !json.ok) {
      return { ok: false, error: json.error || `Bridge error ${res.status}` };
    }
    return json;
  } catch (err: any) {
    return { ok: false, error: err?.message || "تعذر الاتصال بخادم البريد" };
  }
}


export const bridgeVerify = createServerFn({ method: "POST" })
  .inputValidator((input: { account: MailSessionAccount; password: string }) => input)
  .handler(async ({ data }) => {
    return bridgePost("/api/verify", data);
  });

export const bridgeGetFolderCounts = createServerFn({ method: "POST" })
  .inputValidator((input: { account: MailSessionAccount; password: string }) => input)
  .handler(async ({ data }) => {
    const result = await bridgePost("/api/folders", data);
    if (!result.ok) return { ok: false as const, error: result.error as string, counts: [] as FolderCount[] };
    return { ok: true as const, counts: (result.counts ?? []) as FolderCount[] };
  });

export const bridgeGetMessages = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      account: MailSessionAccount;
      password: string;
      folder: MailFolder;
      limit?: number;
      offset?: number;
    }) => input,
  )
  .handler(async ({ data }) => {
    const result = await bridgePost("/api/messages", data);
    if (!result.ok) return { ok: false as const, error: result.error as string, messages: [] as MailMessage[] };
    return { ok: true as const, messages: (result.messages ?? []) as MailMessage[] };
  });

export const bridgeGetMessage = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { account: MailSessionAccount; password: string; folder: MailFolder; uid: number }) => input,
  )
  .handler(async ({ data }) => {
    const result = await bridgePost("/api/message", data);
    if (!result.ok) return { ok: false as const, error: result.error as string, message: null as MailMessage | null };
    return { ok: true as const, message: (result.message as MailMessage | null) ?? null };
  });

export const bridgeMarkRead = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      account: MailSessionAccount;
      password: string;
      folder: MailFolder;
      uid: number;
      read: boolean;
    }) => input,
  )
  .handler(async ({ data }) => {
    return bridgePost("/api/mark-read", data);
  });

export const bridgeStar = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      account: MailSessionAccount;
      password: string;
      folder: MailFolder;
      uid: number;
      starred: boolean;
    }) => input,
  )
  .handler(async ({ data }) => {
    return bridgePost("/api/star", data);
  });

export const bridgeMove = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      account: MailSessionAccount;
      password: string;
      folder: MailFolder;
      uid: number;
      toFolder: MailFolder;
    }) => input,
  )
  .handler(async ({ data }) => {
    return bridgePost("/api/move", data);
  });

export const bridgeDelete = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { account: MailSessionAccount; password: string; folder: MailFolder; uid: number }) => input,
  )
  .handler(async ({ data }) => {
    return bridgePost("/api/delete", data);
  });

export const bridgeSend = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      account: MailSessionAccount;
      password: string;
      to: { name: string; email: string }[];
      cc?: { name: string; email: string }[];
      bcc?: { name: string; email: string }[];
      subject: string;
      bodyHtml?: string;
      bodyText?: string;
    }) => input,
  )
  .handler(async ({ data }) => {
    return bridgePost("/api/send", data);
  });

