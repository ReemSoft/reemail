import { createFileRoute } from "@tanstack/react-router";
import { InlineUploadMetadataSchema } from "@/lib/mail-inline-upload-metadata";

export const Route = createFileRoute("/api/mail-send-v2")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json();
          const token = typeof body?.mailSessionToken === "string" ? body.mailSessionToken : "";
          const password = typeof body?.password === "string" ? body.password : "";
          if (!token || !password) return json({ ok: false, error: "SESSION_REQUIRED" }, 401);
          const inline = InlineUploadMetadataSchema.safeParse(
            Array.isArray(body?.stagedInlineImages)
              ? body.stagedInlineImages.map((item: Record<string, unknown>) => ({
                  uploadFilename: item.uploadFilename,
                  cid: item.cid,
                  contentType: item.contentType,
                }))
              : [],
          );
          if (!inline.success) return json({ ok: false, error: "INVALID_INLINE_IMAGES" }, 400);
          const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
          const auth = await resolveBridgeAuth(token);
          if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
          const safe = {
            account: auth.bridgeAccount,
            password,
            to: Array.isArray(body?.to) ? body.to : [],
            cc: Array.isArray(body?.cc) ? body.cc : [],
            bcc: Array.isArray(body?.bcc) ? body.bcc : [],
            subject: typeof body?.subject === "string" ? body.subject : "",
            bodyHtml: typeof body?.bodyHtml === "string" ? body.bodyHtml : undefined,
            bodyText: typeof body?.bodyText === "string" ? body.bodyText : undefined,
            attachmentHandles: Array.isArray(body?.attachmentHandles) ? body.attachmentHandles : [],
            stagedInlineImages: Array.isArray(body?.stagedInlineImages)
              ? body.stagedInlineImages
              : [],
            sourceAttachments: Array.isArray(body?.sourceAttachments) ? body.sourceAttachments : [],
          };
          const upstream = await fetch(`${auth.bridgeUrl}/api/send-v2`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Bridge-Key": auth.bridgeKey,
            },
            body: JSON.stringify(safe),
          });
          const result = await upstream.text();
          const serverTiming = upstream.headers.get("Server-Timing");
          return new Response(result, {
            status: upstream.status,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "private, no-store",
              ...(serverTiming ? { "Server-Timing": serverTiming } : {}),
            },
          });
        } catch {
          return json({ ok: false, error: "INVALID_PAYLOAD" }, 400);
        }
      },
    },
  },
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}
