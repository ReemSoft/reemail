import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mail-draft-save-v2")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json();
          const token = typeof body?.mailSessionToken === "string" ? body.mailSessionToken : "";
          const password = typeof body?.password === "string" ? body.password : "";
          if (!token || !password) return json({ ok: false, error: "SESSION_REQUIRED" }, 401);
          const { resolveBridgeAuth } = await import("@/lib/mail-bridge-auth.server");
          const auth = await resolveBridgeAuth(token);
          if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
          let upstream: Response;
          try {
            upstream = await fetch(`${auth.bridgeUrl}/api/draft-save-v2`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Bridge-Key": auth.bridgeKey,
              },
              body: JSON.stringify({
                account: auth.bridgeAccount,
                password,
                draftId: body?.draftId,
                to: Array.isArray(body?.to) ? body.to : [],
                cc: Array.isArray(body?.cc) ? body.cc : [],
                bcc: Array.isArray(body?.bcc) ? body.bcc : [],
                subject: typeof body?.subject === "string" ? body.subject : "",
                inReplyTo: typeof body?.inReplyTo === "string" ? body.inReplyTo : undefined,
                references: Array.isArray(body?.references) ? body.references : [],
                bodyHtml: typeof body?.bodyHtml === "string" ? body.bodyHtml : undefined,
                bodyText: typeof body?.bodyText === "string" ? body.bodyText : undefined,
                previousRef: body?.previousRef,
                attachmentHandles: Array.isArray(body?.attachmentHandles)
                  ? body.attachmentHandles
                  : [],
                stagedInlineImages: Array.isArray(body?.stagedInlineImages)
                  ? body.stagedInlineImages
                  : [],
                sourceAttachments: Array.isArray(body?.sourceAttachments)
                  ? body.sourceAttachments
                  : [],
              }),
            });
          } catch {
            // Transport failure to the bridge — surface as a soft NETWORK
            // failure so the composer keeps the local draft instead of
            // bubbling a 5xx (blank-screen error boundary).
            return json({ ok: false, error: "NETWORK", code: "NETWORK" }, 200);
          }
          const result = await upstream.text();
          const isJson = (upstream.headers.get("content-type") ?? "").includes("application/json");
          if (!isJson || upstream.status >= 500) {
            // Gateway/HTML errors (502/503/504 from the reverse proxy) are
            // transport-class, not protocol-class.
            return json({ ok: false, error: "NETWORK", code: "NETWORK" }, 200);
          }
          // Best-effort Local Index write-through on success. IMAP is the
          // source of truth — a projection failure NEVER fails a real save.
          try {
            const parsed = JSON.parse(result) as Record<string, unknown>;
            if (parsed?.ok === true) {
              const { writeDraftProjection } = await import("@/lib/mail-draft-writer.server");
              const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
              await writeDraftProjection(supabaseAdmin, {
                accountId: auth.accountId,
                companyId: auth.companyId,
                folderPath: typeof parsed.folderPath === "string" ? parsed.folderPath : "",
                uid: typeof parsed.uid === "number" ? parsed.uid : null,
                uidValidity: String(parsed.uidValidity ?? ""),
                messageId: typeof parsed.messageId === "string" ? parsed.messageId : null,
                subject: typeof body?.subject === "string" ? body.subject : "",
                from: {
                  name: auth.bridgeAccount.display_name,
                  email: auth.bridgeAccount.email_address,
                },
                to: Array.isArray(body?.to) ? body.to : [],
                cc: Array.isArray(body?.cc) ? body.cc : [],
                internalDate:
                  typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString(),
                hasAttachments:
                  (Array.isArray(body?.attachmentHandles) ? body.attachmentHandles.length : 0) +
                    (Array.isArray(body?.sourceAttachments) ? body.sourceAttachments.length : 0) >
                  0,
                previousRef: body?.previousRef,
              });
            }
          } catch {
            /* projection failure is non-fatal; sync reconciles later */
          }
          return new Response(result, {
            status: upstream.status,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "private, no-store",
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
