import { randomUUID } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { InlineUploadMetadataSchema } from "@/lib/mail-inline-upload-metadata";
import { isNormalSendId } from "@/lib/mail-normal-send-idempotency";
import { sendNormalCompose } from "@/lib/mail-normal-send.server";

export const Route = createFileRoute("/api/mail-send-v2")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return json({ ok: false, error: "INVALID_PAYLOAD" }, 400);
        }

        const token = typeof body.mailSessionToken === "string" ? body.mailSessionToken : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!token || !password) return json({ ok: false, error: "SESSION_REQUIRED" }, 401);

        // Backward compatibility for an already-open pre-deploy tab: a missing
        // sendId gets one ephemeral id. Current clients always send draftId so
        // retries/reloads reuse one durable logical-send identity.
        const requestedSendId = typeof body.sendId === "string" ? body.sendId : "";
        const sendId = requestedSendId || randomUUID();
        if (!isNormalSendId(sendId)) {
          return json({ ok: false, error: "INVALID_SEND_ID" }, 400);
        }

        const inline = InlineUploadMetadataSchema.safeParse(
          Array.isArray(body.stagedInlineImages)
            ? body.stagedInlineImages.map((item) => {
                const value =
                  item && typeof item === "object" ? (item as Record<string, unknown>) : {};
                return {
                  uploadFilename: value.uploadFilename,
                  cid: value.cid,
                  contentType: value.contentType,
                };
              })
            : [],
        );
        if (!inline.success) return json({ ok: false, error: "INVALID_INLINE_IMAGES" }, 400);

        const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
        const auth = await resolveBridgeAuth(token);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

        const payload = {
          to: Array.isArray(body.to) ? body.to : [],
          cc: Array.isArray(body.cc) ? body.cc : [],
          bcc: Array.isArray(body.bcc) ? body.bcc : [],
          subject: typeof body.subject === "string" ? body.subject : "",
          inReplyTo: typeof body.inReplyTo === "string" ? body.inReplyTo : undefined,
          references: Array.isArray(body.references)
            ? body.references.filter((value): value is string => typeof value === "string").slice(0, 100)
            : [],
          bodyHtml: typeof body.bodyHtml === "string" ? body.bodyHtml : undefined,
          bodyText: typeof body.bodyText === "string" ? body.bodyText : undefined,
          attachmentHandles: Array.isArray(body.attachmentHandles) ? body.attachmentHandles : [],
          stagedInlineImages: Array.isArray(body.stagedInlineImages) ? body.stagedInlineImages : [],
          sourceAttachments: Array.isArray(body.sourceAttachments) ? body.sourceAttachments : [],
          sourceInlineImages: Array.isArray(body.sourceInlineImages) ? body.sourceInlineImages : [],
        };

        try {
          const sent = await sendNormalCompose({
            auth,
            password,
            sendId,
            confirmResendUnknown: body.confirmResendUnknown === true,
            payload,
          });
          return json(sent.body, sent.status, sent.serverTiming);
        } catch (error) {
          console.error("[mail-send-v2] durable normal send failed", {
            code: error instanceof Error ? error.message.slice(0, 120) : "UNKNOWN",
          });
          return json(
            { ok: false, code: "SEND_STATE_UNAVAILABLE", error: "SEND_STATE_UNAVAILABLE" },
            503,
          );
        }
      },
    },
  },
});

function json(body: unknown, status: number, serverTiming?: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      ...(serverTiming ? { "Server-Timing": serverTiming } : {}),
    },
  });
}
