import { createFileRoute } from "@tanstack/react-router";

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const SIGNED_URL_TTL = 60 * 60 * 24 * 365 * 10;

export const Route = createFileRoute("/api/mail-signature-image")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = request.headers.get("x-mail-session-token") ?? "";
        const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim();
        const extension = TYPES[contentType];
        if (!token) return json({ ok: false, code: "SESSION_REQUIRED" }, 401);
        if (!extension) return json({ ok: false, code: "UNSUPPORTED_TYPE" }, 415);
        const declaredLength = Number(request.headers.get("content-length") ?? "0");
        if (declaredLength > MAX_BYTES) return json({ ok: false, code: "TOO_LARGE" }, 413);

        const { verifyMailSessionToken } = await import("@/lib/mail-token.server");
        let accountId: string;
        try {
          accountId = (await verifyMailSessionToken(token)).sub;
        } catch {
          return json({ ok: false, code: "INVALID_TOKEN" }, 401);
        }

        const bytes = new Uint8Array(await request.arrayBuffer());
        if (!bytes.length || bytes.byteLength > MAX_BYTES) {
          return json({ ok: false, code: "TOO_LARGE" }, 413);
        }
        const path = `${accountId}/${crypto.randomUUID()}.${extension}`;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const uploaded = await supabaseAdmin.storage
          .from("mail-signature-images")
          .upload(path, bytes, { contentType, cacheControl: "31536000", upsert: false });
        if (uploaded.error) return json({ ok: false, code: "UPLOAD_FAILED" }, 500);
        const signed = await supabaseAdmin.storage
          .from("mail-signature-images")
          .createSignedUrl(path, SIGNED_URL_TTL);
        if (signed.error || !signed.data?.signedUrl) {
          await supabaseAdmin.storage.from("mail-signature-images").remove([path]);
          return json({ ok: false, code: "URL_FAILED" }, 500);
        }
        return json({ ok: true, url: signed.data.signedUrl }, 200);
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