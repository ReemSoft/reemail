import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mail-working-draft-attachment")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const form = await request.formData();
          const token = typeof form.get("mailSessionToken") === "string" ? String(form.get("mailSessionToken")) : "";
          const draftId = typeof form.get("draftId") === "string" ? String(form.get("draftId")) : "";
          const clientKey = typeof form.get("clientKey") === "string" ? String(form.get("clientKey")) : "";
          const kindValue = form.get("kind");
          const kind = kindValue === "attachment" || kindValue === "inline-image" ? kindValue : null;
          const file = form.get("file");
          if (!token || !draftId || !clientKey || !kind || !(file instanceof Blob)) {
            return json({ ok: false, error: "INVALID_UPLOAD" }, 400);
          }
          const working = await import("@/lib/mail-working-draft.server");
          const auth = await working.resolveWorkingDraftAuth(token);
          if (working.isAuthError(auth)) return json({ ok: false, error: auth.code }, auth.status);
          const filename = typeof form.get("filename") === "string" ? String(form.get("filename")) : "attachment";
          const mimeType = typeof form.get("mimeType") === "string" ? String(form.get("mimeType")) : file.type;
          const disposition = typeof form.get("disposition") === "string" ? String(form.get("disposition")) : undefined;
          const cid = typeof form.get("cid") === "string" ? String(form.get("cid")) : undefined;
          const attachment = await working.uploadWorkingDraftAttachment({
            auth,
            draftId,
            clientKey,
            kind,
            filename,
            mimeType: mimeType || "application/octet-stream",
            disposition,
            cid,
            bytes: file,
          });
          return json({ ok: true, attachment });
        } catch (error) {
          const code = error instanceof Error ? error.message : "ATTACHMENT_UPLOAD_FAILED";
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
