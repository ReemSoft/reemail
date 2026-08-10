import { createFileRoute } from "@tanstack/react-router";
import { InlineUploadMetadataSchema } from "@/lib/mail-inline-upload-metadata";

/**
 * Compose+send endpoint. Accepts multipart/form-data from the browser with a
 * JSON `payload` field (containing `mailSessionToken` + `password` + message
 * fields) and any number of `attachments` files.
 *
 * Security model (closes bridge_passthrough_open):
 *   * We verify the signed Mail Session JWT server-side.
 *   * The IMAP/SMTP account is loaded from the DB by verified accountId —
 *     the browser cannot supply host/port/security or an arbitrary account.
 *   * We rebuild a new multipart body with the server-derived `account`
 *     before forwarding to the private Bridge.
 */
export const Route = createFileRoute("/api/mail-send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const contentType = request.headers.get("Content-Type") || "";
        if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
          return json({ ok: false, error: "Expected multipart/form-data" }, 400);
        }

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return json({ ok: false, error: "Invalid multipart body" }, 400);
        }

        const payloadRaw = form.get("payload");
        if (typeof payloadRaw !== "string") {
          return json({ ok: false, error: "Missing payload" }, 400);
        }

        let payload: any;
        try {
          payload = JSON.parse(payloadRaw);
        } catch {
          return json({ ok: false, error: "Invalid payload JSON" }, 400);
        }

        const token =
          typeof payload?.mailSessionToken === "string" ? payload.mailSessionToken : "";
        const password = typeof payload?.password === "string" ? payload.password : "";
        if (!token || !password) {
          return json({ ok: false, error: "جلسة البريد مطلوبة." }, 401);
        }

        const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
        const auth = await resolveBridgeAuth(token);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

        // Rebuild the payload with the server-derived account and only the
        // safe message fields. Any client-supplied `account`/host/port is
        // discarded.
        const inlineParsed = InlineUploadMetadataSchema.safeParse(payload?.inlineImages ?? []);
        if (!inlineParsed.success) {
          return json({ ok: false, error: "Invalid inline image metadata" }, 400);
        }
        const uploadFiles = Array.from(form.entries()).filter(
          ([key, value]) => key === "attachments" && value instanceof File,
        ) as Array<[string, File]>;
        const uploadNames = new Set(uploadFiles.map(([, file]) => file.name));
        if (inlineParsed.data.some((item) => !uploadNames.has(item.uploadFilename))) {
          return json({ ok: false, error: "Inline image file mismatch" }, 400);
        }
        const safePayload = {
          account: auth.bridgeAccount,
          password,
          to: Array.isArray(payload?.to) ? payload.to : [],
          cc: Array.isArray(payload?.cc) ? payload.cc : [],
          bcc: Array.isArray(payload?.bcc) ? payload.bcc : [],
          subject: typeof payload?.subject === "string" ? payload.subject : "",
          inReplyTo: typeof payload?.inReplyTo === "string" ? payload.inReplyTo : undefined,
          references: Array.isArray(payload?.references)
            ? payload.references.filter((value: unknown) => typeof value === "string").slice(0, 100)
            : [],
          bodyHtml: typeof payload?.bodyHtml === "string" ? payload.bodyHtml : undefined,
          bodyText: typeof payload?.bodyText === "string" ? payload.bodyText : undefined,
          inlineImages: inlineParsed.data,
        };

        const outForm = new FormData();
        outForm.append("payload", JSON.stringify(safePayload));
        for (const [k, v] of form.entries()) {
          if (k === "payload") continue;
          if (k === "attachments" && v instanceof File) {
            outForm.append("attachments", v, v.name);
          }
        }

        const upstream = await fetch(`${auth.bridgeUrl}/api/send-multipart`, {
          method: "POST",
          headers: { "X-Bridge-Key": auth.bridgeKey },
          body: outForm,
        });

        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: {
            "Content-Type": upstream.headers.get("Content-Type") || "application/json",
            "Cache-Control": "private, no-store",
          },
        });
      },
    },
  },
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
