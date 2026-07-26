import { createTransport } from "nodemailer";
import type { MailAccount } from "./types.js";

export interface SendAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface SendMessagePayload {
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  cc?: { name: string; email: string }[];
  bcc?: { name: string; email: string }[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  attachments?: SendAttachment[];
}

export async function sendMessage(
  account: MailAccount,
  password: string,
  payload: SendMessagePayload,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const transporter = createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: account.smtp_secure,
    auth: {
      user: account.email_address,
      pass: password,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });

  try {
    const info = await transporter.sendMail({
      from: payload.from.name
        ? `"${payload.from.name}" <${payload.from.email}>`
        : payload.from.email,
      to: payload.to.map((t) => (t.name ? `"${t.name}" <${t.email}>` : t.email)).join(", "),
      cc: payload.cc?.map((c) => (c.name ? `"${c.name}" <${c.email}>` : c.email)).join(", "),
      bcc: payload.bcc?.map((b) => (b.name ? `"${b.name}" <${b.email}>` : b.email)).join(", "),
      subject: payload.subject,
      text: payload.bodyText || "",
      html: payload.bodyHtml || "",
      attachments: payload.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });
    return { ok: true, messageId: info.messageId || "" };
  } catch (err: any) {
    return { ok: false, error: err?.message || "فشل إرسال الرسالة" };
  } finally {
    transporter.close();
  }
}

