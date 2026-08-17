import { createFileRoute } from "@tanstack/react-router";

/**
 * Private, authenticated durable-object read used only for displaying an
 * already-owned inline image. Normal attachment cards deliberately use the
 * metadata returned by the Working Draft document and never call this route.
 */
export const Route = createFileRoute("/api/mail-working-draft-attachment-content")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as Record<string, unknown>;
          const token = typeof body.mailSessionToken === "string" ? body.mailSessionToken : "";
          const draftId = typeof body.draftId === "string" ? body.draftId : "";
          const attachmentId = typeof body.attachmentId === "string" ? body.attachmentId : "";
          if (!token || !draftId || !attachmentId) return json({ ok: false, error: "SESSION_REQUIRED" }, 401);
          const working = await import("@/lib/mail-working-draft.server");
          const auth = await working.resolveWorkingDraftAuth(token);
          if (working.isAuthError(auth)) return json({ ok: false, error: auth.code }, auth.status);
          const attachment = await working.readWorkingDraftAttachment({ auth, draftId, attachmentId });
          return new Response(attachment.bytes, {
            headers: {
              "Content-Type": attachment.mimeType,
              "Content-Length": String(attachment.size),
              "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : "ATTACHMENT_READ_FAILED";
          return json({ ok: false, error: code }, 400);
        }
      },
    },
  },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}
